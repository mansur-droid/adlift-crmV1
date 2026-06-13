import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { Plus, Trash2, Edit, Save, X, Search, Download, Upload, Phone, Users, Briefcase, BarChart3, ClipboardList, Home, LogOut, Lock, ShieldCheck } from 'lucide-react';
import { supabase } from './supabaseClient';
import './styles.css';

const defaultData = {
  leads: [
    { id: crypto.randomUUID(), name: 'Peter Arner', company: 'Compass', email: 'peter@example.com', phone: '', niche: 'Luxury real estate', status: 'Interested', value: '1.5M+ buyers', notes: 'Asked for email. Wants only leads over 1.5M.', created: new Date().toISOString().slice(0,10) }
  ],
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

const rolePermissions = {
  admin: {
    label: 'Admin',
    tabs: ['dashboard', 'leads', 'clients', 'freelancers', 'submissions', 'stats'],
    canExport: true,
    canImport: true,
    canWrite: true,
    canDelete: true
  },
  freelancer: {
    label: 'Freelancer',
    tabs: ['dashboard', 'submissions', 'stats'],
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

function useLocalData() {
  const [data, setData] = useState(() => {
    try { return JSON.parse(localStorage.getItem('adlift-crm-data')) || defaultData; }
    catch { return defaultData; }
  });
  useEffect(() => localStorage.setItem('adlift-crm-data', JSON.stringify(data)), [data]);
  return [data, setData];
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
            : <input type={f.type || 'text'} value={form[f.key] || ''} onChange={e => update(f.key, e.target.value)} />}
        </label>)}
      </div>
      <button className="primary full" onClick={() => onSave({ ...form, id: form.id || crypto.randomUUID(), created: form.created || new Date().toISOString().slice(0,10) })}><Save size={16}/> Save</button>
    </div>
  </div>
}

const fieldSets = {
  leads: [
    {key:'name', label:'Name'}, {key:'company', label:'Company'}, {key:'email', label:'Email'}, {key:'phone', label:'Phone'},
    {key:'niche', label:'Niche'}, {key:'status', label:'Status'}, {key:'value', label:'Value / Criteria'}, {key:'notes', label:'Notes', type:'textarea'}
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

function TableSection({ type, title, data, setData, permissions }) {
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState(null);
  const rows = data[type] || [];
  const filtered = rows.filter(r => JSON.stringify(r).toLowerCase().includes(search.toLowerCase()));
  const save = item => { setData(prev => ({ ...prev, [type]: [...prev[type].filter(x => x.id !== item.id), item] })); setModal(null); };
  const del = id => setData(prev => ({ ...prev, [type]: prev[type].filter(x => x.id !== id) }));
  const keys = fieldSets[type].map(f => f.key).slice(0, 5);

  return <section className="card">
    <div className="sectionTop">
      <div><h1>{title}</h1><p>{filtered.length} records</p></div>
      {permissions.canWrite && <button className="primary" onClick={() => setModal({})}><Plus size={16}/> Add</button>}
    </div>
    <div className="search"><Search size={16}/><input placeholder={`Search ${title.toLowerCase()}...`} value={search} onChange={e => setSearch(e.target.value)} /></div>
    {filtered.length === 0 ? <Empty text="No records yet. Add one."/> : <div className="tableWrap"><table><thead><tr>{keys.map(k => <th key={k}>{k}</th>)}{permissions.canWrite && <th>Actions</th>}</tr></thead><tbody>{filtered.map(r => <tr key={r.id}>{keys.map(k => <td key={k}>{String(r[k] || '-')}</td>)}{permissions.canWrite && <td className="actions"><button onClick={() => setModal(r)}><Edit size={15}/></button>{permissions.canDelete && <button onClick={() => del(r.id)}><Trash2 size={15}/></button>}</td>}</tr>)}</tbody></table></div>}
    {modal && permissions.canWrite && <Modal title={`${modal.id ? 'Edit' : 'Add'} ${title}`} fields={fieldSets[type]} initial={modal} onClose={() => setModal(null)} onSave={save}/>} 
  </section>
}

function Dashboard({ data, role }) {
  const totalDials = data.stats.reduce((s, x) => s + Number(x.dials || 0), 0);
  const totalPickups = data.stats.reduce((s, x) => s + Number(x.pickups || 0), 0);
  const interested = data.stats.reduce((s, x) => s + Number(x.interested || 0), 0);
  const adminCards = [['Leads', data.leads.length], ['Clients', data.clients.length], ['Freelancers', data.freelancers.length], ['Dials', totalDials], ['Pickups', totalPickups], ['Interested', interested]];
  const freelancerCards = [['Submissions', data.submissions.length], ['Dials', totalDials], ['Pickups', totalPickups], ['Interested', interested]];
  const cards = role === 'admin' ? adminCards : freelancerCards;

  return <section className="card"><h1>AdLift Dashboard</h1><p className="sub">Simple CRM for your appointment-setting agency.</p><div className="statsGrid">{cards.map(([a,b]) => <div className="stat" key={a}><span>{a}</span><strong>{b}</strong></div>)}</div>{role === 'admin' && <><h2>Pipeline</h2><div className="pipeline">{['New','Contacted','Interested','Email Sent','Meeting Booked','Won'].map(stage => <div className="pipe" key={stage}><b>{stage}</b><span>{data.leads.filter(l => (l.status || '').toLowerCase() === stage.toLowerCase()).length}</span></div>)}</div></>}</section>
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

  const role = getUserRole(session.user);
  if(!role) return <AccessDenied session={session} onLogout={logout}/>;

  const permissions = rolePermissions[role];
  const visibleTabs = tabs.filter(([id]) => permissions.tabs.includes(id));

  if(!permissions.tabs.includes(tab)) {
    setTimeout(() => setTab('dashboard'), 0);
  }

  const activeTab = permissions.tabs.includes(tab) ? tab : 'dashboard';
  const exportData=()=>{const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='adlift-crm-backup.json'; a.click();};
  const importData=e=>{const file=e.target.files[0]; if(!file) return; const reader=new FileReader(); reader.onload=()=>{try{setData(JSON.parse(reader.result));}catch{alert('Invalid JSON file')}}; reader.readAsText(file)};

  return <div className="app"><aside><div className="brand">AdLift<span>CRM</span></div><div className="userBox"><span>{session.user.email}</span><b className="roleBadge">{permissions.label}</b></div>{visibleTabs.map(([id,Icon,label])=><button className={activeTab===id?'active':''} onClick={()=>setTab(id)} key={id}><Icon size={18}/>{label}</button>)}<div className="sideTools">{permissions.canExport && <button onClick={exportData}><Download size={16}/>Export</button>}{permissions.canImport && <label><Upload size={16}/>Import<input hidden type="file" accept="application/json" onChange={importData}/></label>}<button onClick={logout}><LogOut size={16}/>Logout</button></div></aside><main>{activeTab==='dashboard'?<Dashboard data={data} role={role}/>:<TableSection type={activeTab} title={tabs.find(t=>t[0]===activeTab)[2]} data={data} setData={setData} permissions={permissions}/>}</main></div>
}

createRoot(document.getElementById('root')).render(<App/>);
