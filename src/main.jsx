import React, { useMemo, useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { Plus, Trash2, Edit, Save, X, Search, Download, Upload, Phone, Users, Briefcase, BarChart3, ClipboardList, Home } from 'lucide-react';
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

function useLocalData() {
  const [data, setData] = useState(() => {
    try { return JSON.parse(localStorage.getItem('adlift-crm-data')) || defaultData; }
    catch { return defaultData; }
  });
  useEffect(() => localStorage.setItem('adlift-crm-data', JSON.stringify(data)), [data]);
  return [data, setData];
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

function TableSection({ type, title, data, setData }) {
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState(null);
  const rows = data[type] || [];
  const filtered = rows.filter(r => JSON.stringify(r).toLowerCase().includes(search.toLowerCase()));
  const save = item => { setData(prev => ({ ...prev, [type]: [...prev[type].filter(x => x.id !== item.id), item] })); setModal(null); };
  const del = id => setData(prev => ({ ...prev, [type]: prev[type].filter(x => x.id !== id) }));
  const keys = fieldSets[type].map(f => f.key).slice(0, 5);
  return <section className="card">
    <div className="sectionTop"><div><h1>{title}</h1><p>{filtered.length} records</p></div><button className="primary" onClick={() => setModal({})}><Plus size={16}/> Add</button></div>
    <div className="search"><Search size={16}/><input placeholder={`Search ${title.toLowerCase()}...`} value={search} onChange={e => setSearch(e.target.value)} /></div>
    {filtered.length === 0 ? <Empty text="No records yet. Add one."/> : <div className="tableWrap"><table><thead><tr>{keys.map(k => <th key={k}>{k}</th>)}<th>Actions</th></tr></thead><tbody>{filtered.map(r => <tr key={r.id}>{keys.map(k => <td key={k}>{String(r[k] || '-')}</td>)}<td className="actions"><button onClick={() => setModal(r)}><Edit size={15}/></button><button onClick={() => del(r.id)}><Trash2 size={15}/></button></td></tr>)}</tbody></table></div>}
    {modal && <Modal title={`${modal.id ? 'Edit' : 'Add'} ${title}`} fields={fieldSets[type]} initial={modal} onClose={() => setModal(null)} onSave={save}/>} 
  </section>
}

function Dashboard({ data }) {
  const totalDials = data.stats.reduce((s, x) => s + Number(x.dials || 0), 0);
  const totalPickups = data.stats.reduce((s, x) => s + Number(x.pickups || 0), 0);
  const interested = data.stats.reduce((s, x) => s + Number(x.interested || 0), 0);
  const cards = [['Leads', data.leads.length], ['Clients', data.clients.length], ['Freelancers', data.freelancers.length], ['Dials', totalDials], ['Pickups', totalPickups], ['Interested', interested]];
  return <section className="card"><h1>AdLift Dashboard</h1><p className="sub">Simple CRM for your appointment-setting agency.</p><div className="statsGrid">{cards.map(([a,b]) => <div className="stat" key={a}><span>{a}</span><strong>{b}</strong></div>)}</div><h2>Pipeline</h2><div className="pipeline">{['New','Contacted','Interested','Email Sent','Meeting Booked','Won'].map(stage => <div className="pipe" key={stage}><b>{stage}</b><span>{data.leads.filter(l => (l.status || '').toLowerCase() === stage.toLowerCase()).length}</span></div>)}</div></section>
}

function App(){
  const [data,setData]=useLocalData();
  const [tab,setTab]=useState('dashboard');
  const exportData=()=>{const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='adlift-crm-backup.json'; a.click();};
  const importData=e=>{const file=e.target.files[0]; if(!file) return; const reader=new FileReader(); reader.onload=()=>{try{setData(JSON.parse(reader.result));}catch{alert('Invalid JSON file')}}; reader.readAsText(file)};
  return <div className="app"><aside><div className="brand">AdLift<span>CRM</span></div>{tabs.map(([id,Icon,label])=><button className={tab===id?'active':''} onClick={()=>setTab(id)} key={id}><Icon size={18}/>{label}</button>)}<div className="sideTools"><button onClick={exportData}><Download size={16}/>Export</button><label><Upload size={16}/>Import<input hidden type="file" accept="application/json" onChange={importData}/></label></div></aside><main>{tab==='dashboard'?<Dashboard data={data}/>:<TableSection type={tab} title={tabs.find(t=>t[0]===tab)[2]} data={data} setData={setData}/>}</main></div>
}

createRoot(document.getElementById('root')).render(<App/>);
