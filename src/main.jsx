import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { Plus, Trash2, Edit, Save, X, Search, Download, Upload, Phone, Users, Briefcase, BarChart3, ClipboardList, Home, LogOut, Lock } from 'lucide-react';
import { supabase } from './supabaseClient';
import './styles.css';

const today = () => new Date().toISOString().slice(0, 10);

const leadStatuses = ['dialed', 'opener', 'conversation', 'pitched', 'interested', 'callback', 'booked'];

const defaultData = {
  leads: [],
  clients: [],
  freelancers: [],
  submissions: [],
  stats: []
};

const tabs = [
  ['dashboard', Home, 'Dashboard'],
  ['leads', Phone, 'Leads'],
  ['clients', Briefcase, 'Clients'],
  ['freelancers', Users, 'Freelancers'],
  ['submissions', ClipboardList, 'Submissions'],
  ['stats', BarChart3, 'Cold Call Stats']
];

function useLocalData() {
  const [data, setData] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('adlift-crm-data'));
      return saved ? { ...defaultData, ...saved, leads: normalizeLeads(saved.leads || []) } : defaultData;
    } catch {
      return defaultData;
    }
  });

  useEffect(() => localStorage.setItem('adlift-crm-data', JSON.stringify(data)), [data]);
  return [data, setData];
}

function normalizeHeader(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function csvValue(row, aliases) {
  const key = aliases.map(normalizeHeader).find(alias => row[alias] !== undefined && String(row[alias]).trim() !== '');
  return key ? String(row[key]).trim() : '';
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      i++;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      row.push(cell.trim());
      cell = '';
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i++;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }

  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  if (rows.length < 2) return [];

  const headers = rows[0].map(normalizeHeader);
  return rows.slice(1).map(values => {
    const item = {};
    headers.forEach((header, index) => {
      if (header) item[header] = values[index] || '';
    });
    return item;
  });
}

function mapCsvRowsToLeads(rows) {
  const importedAt = today();

  return rows.map(row => {
    const firstName = csvValue(row, ['first name', 'firstname', 'voornaam']);
    const lastName = csvValue(row, ['last name', 'lastname', 'achternaam']);
    const name = csvValue(row, ['name', 'full name', 'fullname', 'naam', 'lead name', 'contact name']) || [firstName, lastName].filter(Boolean).join(' ');
    const status = csvValue(row, ['status', 'stage', 'lead status']).toLowerCase();

    return {
      id: crypto.randomUUID(),
      name,
      phone: csvValue(row, ['phone', 'phone number', 'phonenumber', 'mobile', 'tel', 'telephone', 'gsm', 'nummer']),
      email: csvValue(row, ['email', 'email address', 'emailaddress', 'mail', 'e-mail', 'e-mailadres']),
      importedAt,
      status: leadStatuses.includes(status) ? status : '',
      notes: csvValue(row, ['notes', 'note', 'opmerkingen', 'notities', 'description']),
      created: importedAt
    };
  }).filter(lead => lead.name || lead.phone || lead.email);
}

function normalizeLeads(leads) {
  return leads.map(lead => ({
    id: lead.id || crypto.randomUUID(),
    name: lead.name || lead.fullName || '',
    phone: lead.phone || '',
    email: lead.email || '',
    importedAt: lead.importedAt || lead.imported_at || lead.created || today(),
    status: leadStatuses.includes(String(lead.status || '').toLowerCase()) ? String(lead.status).toLowerCase() : '',
    notes: lead.notes || '',
    created: lead.created || today()
  }));
}

function Empty({ text }) { return <div className="empty">{text}</div>; }

function Modal({ title, fields, initial = {}, onClose, onSave }) {
  const [form, setForm] = useState(initial);
  const update = (k, v) => setForm(prev => ({ ...prev, [k]: v }));

  return <div className="overlay">
    <div className="modal">
      <div className="modalHead"><h2>{title}</h2><button onClick={onClose}><X size={18}/></button></div>
      <div className="gridForm">
        {fields.map(f => <label key={f.key}>{f.label}
          {f.type === 'textarea'
            ? <textarea value={form[f.key] || ''} onChange={e => update(f.key, e.target.value)} />
            : f.type === 'select'
              ? <select value={form[f.key] || ''} onChange={e => update(f.key, e.target.value)}><option value="">Choose status</option>{(f.options || []).map(option => <option key={option} value={option}>{option}</option>)}</select>
              : <input type={f.type || 'text'} value={form[f.key] || ''} onChange={e => update(f.key, e.target.value)} />}
        </label>)}
      </div>
      <button className="primary full" onClick={() => onSave({ ...form, id: form.id || crypto.randomUUID(), created: form.created || today() })}><Save size={16}/> Save</button>
    </div>
  </div>;
}

const fieldSets = {
  leads: [
    {key:'name', label:'Lead Name'},
    {key:'phone', label:'Phone Number'},
    {key:'email', label:'Email'},
    {key:'importedAt', label:'Imported On', type:'date'},
    {key:'status', label:'Status', type:'select', options: leadStatuses},
    {key:'notes', label:'Notes', type:'textarea'}
  ],
  clients: [
    {key:'name', label:'Client Name'}, {key:'company', label:'Company'}, {key:'email', label:'Email'}, {key:'plan', label:'Plan'},
    {key:'status', label:'Status'}, {key:'monthly', label:'Monthly Retainer'}, {key:'notes', label:'Notes', type:'textarea'}
  ],
  freelancers: [
    {key:'name', label:'Name'}, {key:'role', label:'Role'}, {key:'email', label:'Email'}, {key:'pay', label:'Pay Structure'},
    {key:'status', label:'Status'}, {key:'notes', label:'Notes', type:'textarea'}
  ],
  submissions: [
    {key:'fullName', label:'Full Name'}, {key:'email', label:'Email'}, {key:'phone', label:'Phone'}, {key:'buyerStatus', label:'Buyer Clients?'},
    {key:'leadSource', label:'Current Lead Source'}, {key:'openToAppointments', label:'Open to Appointments?'}, {key:'preferredType', label:'Preferred Client Type'}, {key:'notes', label:'Notes', type:'textarea'}
  ],
  stats: [
    {key:'date', label:'Date', type:'date'}, {key:'dials', label:'Dials', type:'number'}, {key:'pickups', label:'Pickups', type:'number'},
    {key:'conversations', label:'Conversations', type:'number'}, {key:'pitches', label:'Pitches', type:'number'}, {key:'interested', label:'Interested', type:'number'}, {key:'notes', label:'Notes', type:'textarea'}
  ]
};

function headerLabel(type, key) {
  return fieldSets[type].find(field => field.key === key)?.label || key;
}

function TableSection({ type, title, data, setData }) {
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState(null);
  const rows = data[type] || [];
  const filtered = rows.filter(r => JSON.stringify(r).toLowerCase().includes(search.toLowerCase()));
  const keys = type === 'leads' ? ['name', 'phone', 'email', 'importedAt', 'status', 'notes'] : fieldSets[type].map(f => f.key).slice(0, 5);

  const save = item => {
    setData(prev => ({ ...prev, [type]: [...prev[type].filter(x => x.id !== item.id), item] }));
    setModal(null);
  };

  const del = id => setData(prev => ({ ...prev, [type]: prev[type].filter(x => x.id !== id) }));

  const deleteAll = () => {
    if (window.confirm(`Are you sure you want to delete all ${title.toLowerCase()}?`)) {
      setData(prev => ({ ...prev, [type]: [] }));
    }
  };

  const updateLeadStatus = (lead, status) => {
    setData(prev => ({
      ...prev,
      leads: prev.leads.map(item => item.id === lead.id ? { ...item, status } : item)
    }));
  };

  return <section className="card">
    <div className="sectionTop">
      <div><h1>{title}</h1><p>{filtered.length} records</p></div>
      <div className="sectionActions">
        {rows.length > 0 && <button className="danger" onClick={deleteAll}><Trash2 size={16}/> Delete all</button>}
        <button className="primary" onClick={() => setModal(type === 'leads' ? { importedAt: today() } : {})}><Plus size={16}/> Add</button>
      </div>
    </div>
    <div className="search"><Search size={16}/><input placeholder={`Search ${title.toLowerCase()}...`} value={search} onChange={e => setSearch(e.target.value)} /></div>
    {filtered.length === 0 ? <Empty text="No records yet. Add one or import a CSV."/> : <div className="tableWrap"><table><thead><tr>{keys.map(k => <th key={k}>{headerLabel(type, k)}</th>)}<th>Actions</th></tr></thead><tbody>{filtered.map(r => <tr key={r.id}>{keys.map(k => <td key={k}>{type === 'leads' && k === 'status' ? <select className="tableSelect" value={r.status || ''} onChange={e => updateLeadStatus(r, e.target.value)}><option value="">Choose status</option>{leadStatuses.map(status => <option key={status} value={status}>{status}</option>)}</select> : String(r[k] || '-')}</td>)}<td className="actions"><button onClick={() => setModal(r)}><Edit size={15}/></button><button onClick={() => del(r.id)}><Trash2 size={15}/></button></td></tr>)}</tbody></table></div>}
    {modal && <Modal title={`${modal.id ? 'Edit' : 'Add'} ${title}`} fields={fieldSets[type]} initial={modal} onClose={() => setModal(null)} onSave={save}/>} 
  </section>;
}

function Dashboard({ data }) {
  const totalDials = data.stats.reduce((s, x) => s + Number(x.dials || 0), 0);
  const totalPickups = data.stats.reduce((s, x) => s + Number(x.pickups || 0), 0);
  const interested = data.stats.reduce((s, x) => s + Number(x.interested || 0), 0);
  const cards = [['Leads', data.leads.length], ['Clients', data.clients.length], ['Freelancers', data.freelancers.length], ['Dials', totalDials], ['Pickups', totalPickups], ['Interested', interested]];

  return <section className="card"><h1>AdLift Dashboard</h1><p className="sub">Simple CRM for your appointment-setting agency.</p><div className="statsGrid">{cards.map(([a,b]) => <div className="stat" key={a}><span>{a}</span><strong>{b}</strong></div>)}</div><h2>Pipeline</h2><div className="pipeline">{leadStatuses.map(stage => <div className="pipe" key={stage}><b>{stage}</b><span>{data.leads.filter(l => (l.status || '').toLowerCase() === stage).length}</span></div>)}</div></section>;
}

function LoginPage(){
  const [email,setEmail]=useState('');
  const [password,setPassword]=useState('');
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState('');

  const login=async(e)=>{
    e.preventDefault();
    setLoading(true); setError('');
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if(error) setError(error.message);
    setLoading(false);
  };

  return <div className="loginPage">
    <form className="loginCard" onSubmit={login}>
      <div className="loginLogo"><Lock size={24}/><strong>AdLift CRM</strong></div>
      <h1>Private access</h1>
      <p>Login with the account created in Supabase.</p>
      <label>Email<input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@adlift.com" required /></label>
      <label>Password<input type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="••••••••" required /></label>
      {error && <div className="authError">{error}</div>}
      <button className="primary full" disabled={loading}>{loading ? 'Logging in...' : 'Login'}</button>
      <small>No public sign-up. Create users from Supabase → Authentication → Users.</small>
    </form>
  </div>;
}

function App(){
  const [session,setSession]=useState(null);
  const [authLoading,setAuthLoading]=useState(true);
  const [data,setData]=useLocalData();
  const [tab,setTab]=useState('dashboard');

  useEffect(()=>{
    supabase.auth.getSession().then(({data})=>{ setSession(data.session); setAuthLoading(false); });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session)=>setSession(session));
    return ()=>listener.subscription.unsubscribe();
  },[]);

  const logout=async()=>{ await supabase.auth.signOut(); };

  if(authLoading) return <div className="loadingScreen">Loading AdLift CRM...</div>;
  if(!session) return <LoginPage/>;

  const exportData=()=>{const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='adlift-crm-backup.json'; a.click();};
  const importData=e=>{const file=e.target.files[0]; if(!file) return; const reader=new FileReader(); reader.onload=()=>{try{const text = String(reader.result || ''); if(file.name.toLowerCase().endsWith('.csv')){const importedLeads = mapCsvRowsToLeads(parseCsv(text)); setData(prev => ({...prev, leads: [...prev.leads, ...importedLeads]}));}else{const imported = JSON.parse(text); setData({...defaultData, ...imported, leads: normalizeLeads(imported.leads || [])});}}catch{alert('Invalid import file. Use a CSV for leads or a valid AdLift JSON backup.')}}; reader.readAsText(file); e.target.value='';};

  return <div className="app"><aside><div className="brand">AdLift<span>CRM</span></div><div className="userBox">{session.user.email}</div>{tabs.map(([id,Icon,label])=><button className={tab===id?'active':''} onClick={()=>setTab(id)} key={id}><Icon size={18}/>{label}</button>)}<div className="sideTools"><button onClick={exportData}><Download size={16}/>Export</button><label><Upload size={16}/>Import CSV/JSON<input hidden type="file" accept=".json,.csv,application/json,text/csv" onChange={importData}/></label><button onClick={logout}><LogOut size={16}/>Logout</button></div></aside><main>{tab==='dashboard'?<Dashboard data={data}/>:<TableSection type={tab} title={tabs.find(t=>t[0]===tab)[2]} data={data} setData={setData}/>}</main></div>;
}

createRoot(document.getElementById('root')).render(<App/>);
