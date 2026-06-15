import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { Plus, Trash2, Edit, Save, X, Search, Download, Upload, Phone, Users, Briefcase, BarChart3, ClipboardList, Home, LogOut, Lock, ShieldCheck, RefreshCw } from 'lucide-react';
import { supabase } from './supabaseClient';
import './styles.css';

const emptyData = {
  leads: [],
  clients: [],
  freelancers: [],
  submissions: [],
  stats: []
};

const coldCallStatuses = ['dialed', 'opener', 'conversation', 'pitched', 'interested', 'callback', 'booked'];
const today = () => new Date().toISOString().slice(0, 10);

const tabs = [
  ['dashboard', Home, 'Dashboard'],
  ['leads', Phone, 'Leads'],
  ['clients', Briefcase, 'Clients'],
  ['freelancers', Users, 'Freelancers'],
  ['submissions', ClipboardList, 'Submissions'],
  ['stats', BarChart3, 'Cold Call Stats']
];

const rolePermissions = {
  admin: {
    label: 'Admin',
    tabs: ['dashboard', 'leads', 'clients', 'freelancers', 'submissions', 'stats'],
    recordTypes: ['leads', 'clients', 'freelancers', 'submissions', 'stats'],
    canExport: true,
    canImport: true,
    canWrite: true,
    canDelete: true
  },
  freelancer: {
    label: 'Freelancer',
    tabs: ['dashboard', 'submissions', 'stats'],
    recordTypes: ['submissions', 'stats'],
    canExport: false,
    canImport: false,
    canWrite: true,
    canDelete: false
  }
};

function getUserRole(user) {
  const rawRole = user?.app_metadata?.role || user?.user_metadata?.role || '';
  const role = String(rawRole).trim().toLowerCase();
  return rolePermissions[role] ? role : null;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function normalizeHeader(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
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
    } else if ((char === ',' || char === ';' || char === '\t') && !inQuotes) {
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

function getCsvValue(row, aliases) {
  const key = aliases.map(normalizeHeader).find(alias => row[alias] !== undefined && String(row[alias]).trim() !== '');
  return key ? String(row[key]).trim() : '';
}

function normalizeColdCallStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  return coldCallStatuses.includes(status) ? status : '';
}

function mapCsvRowsToColdCallProspects(rows) {
  const importedAt = today();

  return rows.map(row => {
    const firstName = getCsvValue(row, ['first name', 'firstname', 'voornaam']);
    const lastName = getCsvValue(row, ['last name', 'lastname', 'achternaam']);
    const name = getCsvValue(row, ['name', 'full name', 'fullname', 'naam', 'lead name', 'contact name', 'agent name', 'realtor name', 'title', 'persoon', 'contact']) || [firstName, lastName].filter(Boolean).join(' ');

    return {
      name,
      phone: getCsvValue(row, ['phone', 'phone number', 'phonenumber', 'mobile', 'tel', 'telephone', 'gsm', 'nummer', 'telefoon', 'mobiel']),
      email: getCsvValue(row, ['email', 'email address', 'emailaddress', 'mail', 'e-mail', 'e-mailadres', 'email1']),
      importedAt,
      status: normalizeColdCallStatus(getCsvValue(row, ['status', 'stage', 'lead status', 'cold call status'])),
      notes: getCsvValue(row, ['notes', 'note', 'opmerkingen', 'notities', 'description', 'omschrijving'])
    };
  }).filter(prospect => prospect.name || prospect.phone || prospect.email);
}

function mapCsvRowsToType(type, rows) {
  if (type === 'stats') return mapCsvRowsToColdCallProspects(rows);

  const aliases = {
    name: ['name', 'fullname', 'fullnaam', 'voornaamachternaam', 'leadname', 'contactname'],
    fullName: ['fullname', 'name', 'naam', 'contactname'],
    company: ['company', 'bedrijf', 'agency', 'brokerage', 'kantoor'],
    email: ['email', 'emailaddress', 'mail', 'e-mailadres'],
    phone: ['phone', 'phonenumber', 'tel', 'telephone', 'gsm', 'nummer'],
    niche: ['niche', 'market', 'markt'],
    status: ['status', 'stage'],
    value: ['value', 'criteria', 'budget', 'price', 'waarde'],
    notes: ['notes', 'note', 'opmerkingen', 'notities', 'description'],
    plan: ['plan'],
    monthly: ['monthly', 'retainer', 'monthlyretainer'],
    role: ['role', 'functie'],
    pay: ['pay', 'payment', 'paystructure', 'payout'],
    buyerStatus: ['buyerstatus', 'buyerclients', 'buyers', 'areyoucurrentlyworkingwithbuyerclients'],
    leadSource: ['leadsource', 'source', 'howareyoucurrentlygeneratingbuyerleads'],
    openToAppointments: ['opentoappointments', 'appointment', 'areyouopentoreceivingprequalifiedbuyerappointments'],
    preferredType: ['preferredtype', 'preferredclienttype', 'clienttype']
  };

  const fields = fieldSets[type] || fieldSets.leads;
  return rows.map(row => {
    const item = {};
    fields.forEach(field => {
      item[field.key] = getCsvValue(row, aliases[field.key] || [field.key]);
    });
    return item;
  });
}

function groupRecords(rows) {
  const grouped = { ...emptyData };
  rows.forEach(row => {
    if (!grouped[row.type]) return;
    if (row.payload?.deleted) return;
    grouped[row.type].push({ ...(row.payload || {}), id: row.id });
  });
  return grouped;
}

function useSupabaseData(role) {
  const [data, setData] = useState(emptyData);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const loadData = async () => {
    if (!role) return;
    setLoading(true);
    setError('');

    const allowedTypes = rolePermissions[role].recordTypes;
    const { data: rows, error } = await supabase
      .from('crm_records')
      .select('id,type,payload,created_at')
      .in('type', allowedTypes)
      .order('created_at', { ascending: false });

    if (error) {
      setError(error.message);
      setData(emptyData);
    } else {
      setData(groupRecords(rows || []));
    }

    setLoading(false);
  };

  useEffect(() => {
    loadData();
  }, [role]);

  const saveRecord = async (type, item) => {
    if (!rolePermissions[role]?.recordTypes.includes(type)) return;

    const id = isUuid(item.id) ? item.id : crypto.randomUUID();
    const payload = {
      ...item,
      id,
      deleted: false,
      created: item.created || today(),
      importedAt: type === 'stats' ? (item.importedAt || today()) : item.importedAt
    };

    const visibleItem = { ...payload, id };
    setData(prev => ({
      ...prev,
      [type]: (prev[type] || []).some(row => row.id === id)
        ? (prev[type] || []).map(row => row.id === id ? visibleItem : row)
        : [visibleItem, ...(prev[type] || [])]
    }));

    const { error } = await supabase
      .from('crm_records')
      .upsert({ id, type, payload, updated_at: new Date().toISOString() });

    if (error) {
      setError(error.message);
      return;
    }
  };

  const softDeleteRows = async (type, items) => {
    if (!rolePermissions[role]?.canDelete || !rolePermissions[role]?.recordTypes.includes(type)) return;
    if (!items.length) return;

    setData(prev => ({
      ...prev,
      [type]: (prev[type] || []).filter(row => !items.some(item => item.id === row.id))
    }));

    const deletedAt = new Date().toISOString();
    const rows = items.map(item => ({
      id: item.id,
      type,
      payload: { ...item, deleted: true, deletedAt },
      updated_at: deletedAt
    }));

    const { error } = await supabase.from('crm_records').upsert(rows);

    if (error) {
      setError(error.message);
      return;
    }
  };

  const deleteRecord = async (type, id) => {
    const item = data[type]?.find(row => row.id === id);
    if (!item) return;
    await softDeleteRows(type, [item]);
  };

  const deleteAllRecords = async type => {
    await softDeleteRows(type, data[type] || []);
  };

  const importRecords = async importedData => {
    if (!rolePermissions[role]?.canImport) return;

    const newVisibleData = {};
    const rows = Object.entries(importedData || {}).flatMap(([type, items]) => {
      if (!rolePermissions[role].recordTypes.includes(type) || !Array.isArray(items)) return [];
      newVisibleData[type] = [];
      return items.map(item => {
        const id = isUuid(item.id) ? item.id : crypto.randomUUID();
        const payload = { ...item, id, deleted: false, created: item.created || today(), importedAt: type === 'stats' ? (item.importedAt || today()) : item.importedAt };
        newVisibleData[type].push(payload);
        return {
          id,
          type,
          payload,
          updated_at: new Date().toISOString()
        };
      });
    });

    if (!rows.length) return;

    setData(prev => {
      const next = { ...prev };
      Object.entries(newVisibleData).forEach(([type, items]) => {
        next[type] = [...items, ...(prev[type] || [])];
      });
      return next;
    });

    const { error } = await supabase.from('crm_records').upsert(rows);

    if (error) {
      setError(error.message);
      return;
    }
  };

  return { data, loading, error, loadData, saveRecord, deleteRecord, deleteAllRecords, importRecords };
}

function Empty({ text }) { return <div className="empty">{text}</div>; }

function AccessDenied({ session, onLogout }) {
  return <div className="loginPage">
    <div className="loginCard">
      <div className="loginLogo"><ShieldCheck size={24}/><strong>AdLift CRM</strong></div>
      <h1>No role assigned</h1>
      <p>This account is logged in, but it does not have an admin or freelancer role yet.</p>
      <div className="authError">Ask the Supabase admin to set <b>role</b> to <b>admin</b> or <b>freelancer</b> in this user's metadata.</div>
      <small>{session.user.email}</small>
      <button className="primary full" onClick={onLogout}><LogOut size={16}/>Logout</button>
    </div>
  </div>
}

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
  </div>
}

const fieldSets = {
  leads: [
    {key:'name', label:'Client Lead Name'},
    {key:'company', label:'Client / Company'},
    {key:'email', label:'Email'},
    {key:'phone', label:'Phone'},
    {key:'niche', label:'Niche'},
    {key:'status', label:'Qualification Status'},
    {key:'value', label:'Value / Criteria'},
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
    {key:'name', label:'Prospect Name'},
    {key:'phone', label:'Phone Number'},
    {key:'email', label:'Email'},
    {key:'importedAt', label:'Imported On', type:'date'},
    {key:'status', label:'Cold Call Status', type:'select', options: coldCallStatuses},
    {key:'notes', label:'Notes', type:'textarea'}
  ]
};

function formatHeader(type, key) {
  return fieldSets[type].find(field => field.key === key)?.label || key;
}

function renderCell(type, key, row, permissions, onSave) {
  if (type === 'stats' && key === 'status' && permissions.canWrite) {
    return <select className="tableSelect" value={row.status || ''} onChange={e => onSave(type, { ...row, status: e.target.value })}>
      <option value="">Choose status</option>
      {coldCallStatuses.map(status => <option key={status} value={status}>{status}</option>)}
    </select>;
  }

  return String(row[key] || '-');
}

function TableSection({ type, title, data, permissions, onSave, onDelete, onDeleteAll }) {
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState(null);
  const rows = data[type] || [];
  const filtered = rows.filter(r => JSON.stringify(r).toLowerCase().includes(search.toLowerCase()));
  const save = async item => { await onSave(type, item); setModal(null); };
  const keys = type === 'stats' ? ['name', 'phone', 'email', 'importedAt', 'status', 'notes'] : fieldSets[type].map(f => f.key).slice(0, 5);

  const handleDeleteAll = async () => {
    const confirmed = window.confirm(`Are you sure you want to delete all ${title.toLowerCase()}? This cannot be undone.`);
    if (confirmed) await onDeleteAll(type);
  };

  return <section className="card">
    <div className="sectionTop">
      <div><h1>{title}</h1><p>{filtered.length} records</p></div>
      <div className="sectionActions">
        {permissions.canDelete && rows.length > 0 && <button className="danger" onClick={handleDeleteAll}><Trash2 size={16}/> Delete all</button>}
        {permissions.canWrite && <button className="primary" onClick={() => setModal(type === 'stats' ? { importedAt: today() } : {})}><Plus size={16}/> Add</button>}
      </div>
    </div>
    <div className="search"><Search size={16}/><input placeholder={`Search ${title.toLowerCase()}...`} value={search} onChange={e => setSearch(e.target.value)} /></div>
    {filtered.length === 0 ? <Empty text="No records yet. Add one or import a CSV."/> : <div className="tableWrap"><table><thead><tr>{keys.map(k => <th key={k}>{formatHeader(type, k)}</th>)}{permissions.canWrite && <th>Actions</th>}</tr></thead><tbody>{filtered.map(r => <tr key={r.id}>{keys.map(k => <td key={k}>{renderCell(type, k, r, permissions, onSave)}</td>)}{permissions.canWrite && <td className="actions"><button onClick={() => setModal(r)}><Edit size={15}/></button>{permissions.canDelete && <button onClick={() => onDelete(type, r.id)}><Trash2 size={15}/></button>}</td>}</tr>)}</tbody></table></div>}
    {modal && permissions.canWrite && <Modal title={`${modal.id ? 'Edit' : 'Add'} ${title}`} fields={fieldSets[type]} initial={modal} onClose={() => setModal(null)} onSave={save}/>} 
  </section>
}

function Dashboard({ data, role }) {
  const prospects = data.stats || [];
  const interested = prospects.filter(x => x.status === 'interested').length;
  const booked = prospects.filter(x => x.status === 'booked').length;
  const callbacks = prospects.filter(x => x.status === 'callback').length;
  const adminCards = [['Client Leads', data.leads.length], ['Clients', data.clients.length], ['Freelancers', data.freelancers.length], ['Cold Call Prospects', prospects.length], ['Interested', interested], ['Booked', booked]];
  const freelancerCards = [['Submissions', data.submissions.length], ['Cold Call Prospects', prospects.length], ['Callbacks', callbacks], ['Booked', booked]];
  const cards = role === 'admin' ? adminCards : freelancerCards;

  return <section className="card"><h1>AdLift Dashboard</h1><p className="sub">Shared CRM data from Supabase.</p><div className="statsGrid">{cards.map(([a,b]) => <div className="stat" key={a}><span>{a}</span><strong>{b}</strong></div>)}</div>{role === 'admin' && <><h2>Cold Call Pipeline</h2><div className="pipeline">{coldCallStatuses.map(stage => <div className="pipe" key={stage}><b>{stage}</b><span>{prospects.filter(l => (l.status || '').toLowerCase() === stage).length}</span></div>)}</div></>}</section>
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
  </div>
}

function App(){
  const [session,setSession]=useState(null);
  const [authLoading,setAuthLoading]=useState(true);
  const [tab,setTab]=useState('dashboard');

  useEffect(()=>{
    supabase.auth.getSession().then(({data})=>{ setSession(data.session); setAuthLoading(false); });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session)=>setSession(session));
    return ()=>listener.subscription.unsubscribe();
  },[]);

  const role = session ? getUserRole(session.user) : null;
  const store = useSupabaseData(role);

  useEffect(() => {
    if (role && !rolePermissions[role].tabs.includes(tab)) setTab('dashboard');
  }, [role, tab]);

  const logout=async()=>{ await supabase.auth.signOut(); };

  if(authLoading) return <div className="loadingScreen">Loading AdLift CRM...</div>;
  if(!session) return <LoginPage/>;
  if(!role) return <AccessDenied session={session} onLogout={logout}/>;

  const permissions = rolePermissions[role];
  const visibleTabs = tabs.filter(([id]) => permissions.tabs.includes(id));
  const activeTab = permissions.tabs.includes(tab) ? tab : 'dashboard';
  const exportData=()=>{const blob=new Blob([JSON.stringify(store.data,null,2)],{type:'application/json'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='adlift-crm-backup.json'; a.click();};
  const importData=e=>{const file=e.target.files[0]; if(!file) return; const reader=new FileReader(); reader.onload=async()=>{try{const text=String(reader.result || ''); if(file.name.toLowerCase().endsWith('.csv')){const rows = parseCsv(text); await store.importRecords({ stats: mapCsvRowsToType('stats', rows) }); setTab('stats');}else{await store.importRecords(JSON.parse(text));}}catch{alert('Invalid import file. Use a valid CSV or AdLift JSON backup.')}}; reader.readAsText(file); e.target.value='';};

  return <div className="app"><aside><div className="brand">AdLift<span>CRM</span></div><div className="userBox"><span>{session.user.email}</span><b className="roleBadge">{permissions.label}</b></div>{visibleTabs.map(([id,Icon,label])=><button className={activeTab===id?'active':''} onClick={()=>setTab(id)} key={id}><Icon size={18}/>{label}</button>)}<div className="sideTools">{permissions.canExport && <button onClick={exportData}><Download size={16}/>Export</button>}{permissions.canImport && <label><Upload size={16}/>Import<input hidden type="file" accept=".json,.csv,application/json,text/csv" onChange={importData}/></label>}<button onClick={store.loadData}><RefreshCw size={16}/>Refresh</button><button onClick={logout}><LogOut size={16}/>Logout</button></div></aside><main>{store.error && <div className="dataError">{store.error}</div>}{store.loading ? <div className="loadingScreen inline">Loading CRM data...</div> : activeTab==='dashboard'?<Dashboard data={store.data} role={role}/>:<TableSection type={activeTab} title={tabs.find(t=>t[0]===activeTab)[2]} data={store.data} permissions={permissions} onSave={store.saveRecord} onDelete={store.deleteRecord} onDeleteAll={store.deleteAllRecords}/>}</main></div>
}

createRoot(document.getElementById('root')).render(<App/>);
