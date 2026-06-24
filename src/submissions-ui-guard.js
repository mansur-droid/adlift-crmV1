function isColdCallStatsActive(){
  return [...document.querySelectorAll('aside button.active')].some(button=>button.textContent&&button.textContent.includes('Cold Call Stats'));
}

function getColdCallTable(){
  if(!isColdCallStatsActive())return null;
  const table=document.querySelector('main table');
  if(!table)return null;
  const headers=[...table.querySelectorAll('thead th')].map(th=>th.textContent.trim().toLowerCase());
  const batchIndex=headers.findIndex(h=>h.includes('imported'));
  if(batchIndex<0)return null;
  return {table,batchIndex};
}

function ensureBatchFilter(){
  const found=getColdCallTable();
  if(!found)return;
  const {table,batchIndex}=found;
  const searchBox=document.querySelector('main .search');
  if(!searchBox)return;

  let wrapper=document.getElementById('coldcall-batch-filter');
  if(!wrapper){
    wrapper=document.createElement('div');
    wrapper.id='coldcall-batch-filter';
    wrapper.style.display='flex';
    wrapper.style.alignItems='center';
    wrapper.style.gap='10px';
    wrapper.style.margin='12px 0';
    wrapper.innerHTML='<label style="font-weight:700;color:inherit">Batch</label><select style="min-width:240px;background:#090e1b;border:1px solid #2a3656;color:#fff;border-radius:11px;padding:10px;font:inherit"><option value="">All batches</option></select>';
    searchBox.parentNode.insertBefore(wrapper,searchBox.nextSibling);
    wrapper.querySelector('select').addEventListener('change',event=>{
      localStorage.setItem('coldcall_batch_filter',event.target.value);
      applyColdCallBatchFilter();
    });
  }

  const select=wrapper.querySelector('select');
  const rows=[...table.querySelectorAll('tbody tr')];
  const batches=[...new Set(rows.map(row=>(row.children[batchIndex]?.textContent||'').trim()).filter(Boolean))].sort((a,b)=>b.localeCompare(a,undefined,{sensitivity:'base'}));
  const current=localStorage.getItem('coldcall_batch_filter')||'';
  const options=['',...batches];
  const nextHtml=options.map(value=>`<option value="${value.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;')}">${value?`Batch: ${value}`:'All batches'}</option>`).join('');
  if(select.innerHTML!==nextHtml)select.innerHTML=nextHtml;
  select.value=batches.includes(current)?current:'';
}

function applyColdCallBatchFilter(){
  const found=getColdCallTable();
  if(!found)return;
  const {table,batchIndex}=found;
  const selected=document.querySelector('#coldcall-batch-filter select')?.value||'';
  [...table.querySelectorAll('tbody tr')].forEach(row=>{
    const batch=(row.children[batchIndex]?.textContent||'').trim();
    row.style.display=!selected||batch===selected?'':'none';
  });
}

function sortColdCallRowsByName(){
  const found=getColdCallTable();
  if(!found)return;
  const tbody=found.table.querySelector('tbody');
  if(!tbody)return;
  const rows=[...tbody.querySelectorAll('tr')];
  if(rows.length<2)return;
  const sorted=[...rows].sort((a,b)=>{
    const aName=(a.querySelector('td')?.textContent||'').trim().toLowerCase();
    const bName=(b.querySelector('td')?.textContent||'').trim().toLowerCase();
    return aName.localeCompare(bName,undefined,{sensitivity:'base'});
  });
  if(!rows.every((row,index)=>row===sorted[index]))sorted.forEach(row=>tbody.appendChild(row));
}

function updateColdCallTools(){
  ensureBatchFilter();
  sortColdCallRowsByName();
  applyColdCallBatchFilter();
}

window.addEventListener('load',updateColdCallTools);
document.addEventListener('click',()=>setTimeout(updateColdCallTools,300));
setInterval(updateColdCallTools,1500);
