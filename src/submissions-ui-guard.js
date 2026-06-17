function updateSubmissionsUi(){
  const cards=[...document.querySelectorAll('.card')];
  cards.forEach(card=>{
    const title=card.querySelector('h1')?.textContent?.trim();
    if(title!=='Submissions')return;
    const addButton=[...card.querySelectorAll('button')].find(btn=>btn.textContent?.trim()==='Add');
    if(addButton)addButton.style.display='none';
    const countText=card.querySelector('.sectionTop p');
    if(countText){
      const count=countText.textContent?.match(/\d+/)?.[0]||'0';
      countText.textContent=`${count} Google Form submissions`;
    }
    const empty=card.querySelector('.empty');
    if(empty)empty.textContent='No Google Form submissions yet. Submit the connected form once, then refresh this page.';
  });
}

const observer=new MutationObserver(updateSubmissionsUi);
observer.observe(document.documentElement,{childList:true,subtree:true});
window.addEventListener('load',updateSubmissionsUi);
setInterval(updateSubmissionsUi,1000);
