function isColdCallStatsActive(){
  const active=[...document.querySelectorAll('aside button.active')].find(button=>button.textContent && button.textContent.includes('Cold Call Stats'));
  return Boolean(active);
}

function sortColdCallTable(){
  if(!isColdCallStatsActive())return;
  const table=document.querySelector('main table');
  if(!table)return;
  const tbody=table.querySelector('tbody');
  if(!tbody)return;
  const rows=[...tbody.querySelectorAll('tr')];
  if(rows.length<2)return;

  const sorted=[...rows].sort((a,b)=>{
    const nameA=(a.querySelector('td')?.textContent||'').trim().toLowerCase();
    const nameB=(b.querySelector('td')?.textContent||'').trim().toLowerCase();
    return nameA.localeCompare(nameB,undefined,{sensitivity:'base'});
  });

  const alreadySorted=rows.every((row,index)=>row===sorted[index]);
  if(alreadySorted)return;
  sorted.forEach(row=>tbody.appendChild(row));
}

window.addEventListener('load',sortColdCallTable);
document.addEventListener('click',()=>setTimeout(sortColdCallTable,250));
setInterval(sortColdCallTable,1500);
