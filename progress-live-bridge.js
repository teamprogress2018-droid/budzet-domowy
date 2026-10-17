/* Progress Live → Budżet Domowy.
 * Progress Live zapisuje tu tylko potwierdzone wpłaty za pakiety. Kalendarz
 * pozostaje w Progress Live; ten importer tworzy w Budżecie jeden przychód
 * na unikalne zdarzenie, więc nie dubluje pojedynczych treningów z pakietu.
 */
(function(){
  'use strict';
  const OUTBOX_KEY='progress_live_budget_outbox_v1';
  const MAX_AMOUNT=99999999.99;
  const MONTHS=['Styczeń','Luty','Marzec','Kwiecień','Maj','Czerwiec','Lipiec','Sierpień','Wrzesień','Październik','Listopad','Grudzień'];

  function readOutbox(){
    try{const value=JSON.parse(localStorage.getItem(OUTBOX_KEY)||'[]');return Array.isArray(value)?value:[];}
    catch(error){return [];}
  }
  function writeOutbox(value){
    try{localStorage.setItem(OUTBOX_KEY,JSON.stringify(value));return true;}
    catch(error){console.warn('Nie udało się zaktualizować kolejki Progress Live',error);return false;}
  }
  function text(value,max){return String(value==null?'':value).replace(/[\u0000-\u001f<>]/g,' ').replace(/\s+/g,' ').trim().slice(0,max||140);}
  function isoDate(value){
    const iso=String(value||'').slice(0,10);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(iso))return '';
    const parsed=new Date(iso+'T00:00:00Z');
    return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===iso?iso:'';
  }
  function normalise(event){
    if(!event||event.v!==1||event.source!=='progress-live'||event.kind!=='package-payment'||event.status!=='paid')return null;
    const id=text(event.id,180),date=isoDate(event.occurredOn),amount=Number(event.amount);
    if(!/^progress-live:package:[^\s]{1,140}$/.test(id)||!date||!Number.isFinite(amount)||amount<=0||amount>MAX_AMOUNT)return null;
    const dt=new Date(date+'T00:00:00Z');
    return {
      id,date,amount:Math.round(amount*100)/100,
      clientName:text(event.clientName,100),title:text(event.title,120)||'Pakiet treningowy',
      paymentMethod:event.paymentMethod==='cash'?'cash':'bank',
      month:MONTHS[dt.getUTCMonth()]+' '+dt.getUTCFullYear(),
      displayDate:String(dt.getUTCDate()).padStart(2,'0')+'.'+String(dt.getUTCMonth()+1).padStart(2,'0')+'.'+dt.getUTCFullYear()
    };
  }
  function refreshVisiblePage(){
    try{
      if(typeof curPage==='undefined')return;
      if(curPage==='dashboard'&&typeof renderDash==='function')renderDash();
      if(curPage==='income'&&typeof renderIncome==='function')renderIncome();
      if(curPage==='transactions'&&typeof renderTx==='function')renderTx();
      if(typeof renderSidebar==='function')renderSidebar();
    }catch(error){console.warn('Odświeżenie po imporcie Progress Live',error);}
  }
  let listening=false;

  window.pullProgressLiveIncomeQueue=function(){
    const outbox=readOutbox();
    if(!outbox.length||!Array.isArray(data))return {imported:0,duplicates:0,invalid:0};
    const known=new Set(data.map(tx=>String(tx&&tx.externalId||'')));
    const pending=[];let invalid=0,duplicates=0;
    outbox.forEach((event,index)=>{
      const safe=normalise(event);
      if(!safe){if(event&&event.status==='paid')invalid++;return;}
      if(event.status==='imported'||known.has(safe.id)){if(event.status==='paid')duplicates++;return;}
      pending.push({index,safe});
    });
    if(!pending.length)return {imported:0,duplicates,invalid};

    const start=Date.now();
    const added=pending.map((row,offset)=>({
      id:start+offset,date:row.safe.displayDate,iso:row.safe.date,month:row.safe.month,
      name:'Progress Live — '+(row.safe.clientName?row.safe.clientName+' · ':'')+row.safe.title,
      cat:'Plan treningowy',amt:row.safe.amount,src:row.safe.paymentMethod,
      externalId:row.safe.id,integrationSource:'progress-live'
    }));
    data.push(...added);
    if(typeof save!=='function'||save()===false){
      data.splice(data.length-added.length,added.length);
      return {imported:0,duplicates,invalid,failed:true};
    }
    const importedAt=new Date().toISOString();
    pending.forEach((row,index)=>{
      outbox[row.index]={...outbox[row.index],status:'imported',importedAt,budgetTransactionId:added[index].id};
    });
    writeOutbox(outbox);
    refreshVisiblePage();
    return {imported:added.length,duplicates,invalid};
  };
  // Gdy Budżet jest już otwarty w drugiej karcie, wpłata z Progress Live
  // zostanie pobrana od razu. Nasłuch startuje dopiero po zalogowaniu.
  window.startProgressLiveIncomeBridge=function(){
    if(listening)return;
    listening=true;
    window.addEventListener('storage',event=>{
      if(event.key!==OUTBOX_KEY)return;
      window.setTimeout(()=>{
        try{window.pullProgressLiveIncomeQueue();}catch(error){console.warn('Import Progress Live',error);}
      },50);
    });
  };
})();
