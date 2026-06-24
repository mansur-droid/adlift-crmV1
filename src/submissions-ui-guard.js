function isColdCallStatsActive(){
  return [...document.querySelectorAll('aside button.active')].some(button=>button.textContent&&button.textContent.includes('Cold Call Stats'));
}

function sortColdCallRowsByName(){
  if(!isColdCallStatsActive())return;
  const tbody=document.querySelector('main table tbody');
  if(!tbody)return;
  const rows=[...tbody.querySelectorAll('tr')];
  if(rows.length<2)return;
  const sorted=[...rows].sort((a,b)=>{
    const aName=(a.querySelector('td')?.textContent||'').trim().toLowerCase();
    const bName=(b.querySelector('td')?.textContent||'').trim().toLowerCase();
    return aName.localeCompare(bName,undefined,{sensitivity:'base'});
  });
  if(rows.every((row,index)=>row===sorted[index]))return;
  sorted.forEach(row=>tbody.appendChild(row));
}

window.addEventListener('load',sortColdCallRowsByName);
document.addEventListener('click',()=>setTimeout(sortColdCallRowsByName,300));
setInterval(sortColdCallRowsByName,1500);
