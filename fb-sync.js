// ═══════════════════════════════════════════════════════════
// FIREBASE — AUTORYZACJA I SYNCHRONIZACJA
// (budzet_v3, debts, impulsePurchases, holdings)
// ═══════════════════════════════════════════════════════════
// localStorage zostaje szybką warstwą lokalną. Firestore trzyma
// kopię całego budżetu, żeby po wyczyszczeniu przeglądarki dało
// się dane przywrócić. Demo/seed nigdy nie nadpisuje chmury.

const firebaseConfig = {
  apiKey: "AIzaSyD1v6VJuQrg3rZ5bns0ZUgAO_U3UfhRZ94",
  authDomain: "budzet-domowy-app.firebaseapp.com",
  projectId: "budzet-domowy-app",
  storageBucket: "budzet-domowy-app.firebasestorage.app",
  messagingSenderId: "670455485101",
  appId: "1:670455485101:web:06d04284fce1e89c4a6c24",
  measurementId: "G-S760V2W3JJ"
};

firebase.initializeApp(firebaseConfig);
const fbAuth = firebase.auth();
const fbDb = firebase.firestore();
let fbCurrentUser = null;

function fbSetStatus(text, isError){
  const el = document.getElementById('fb-sync-status');
  if(el){ el.textContent = text; el.style.color = isError ? 'var(--red)' : 'var(--text3)'; }
}

// ── LOGOWANIE ──
function fbDoLogin(){
  const email = document.getElementById('login-email').value.trim();
  const pass = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  const btn = document.getElementById('login-btn');
  errEl.textContent = '';
  if(!email || !pass){ errEl.textContent = 'Podaj e-mail i hasło.'; return; }
  btn.disabled = true; btn.textContent = 'Loguję...';
  fbAuth.signInWithEmailAndPassword(email, pass)
    .catch(e=>{
      errEl.textContent = 'Błąd logowania: ' + fbFriendlyError(e.code);
    })
    .finally(()=>{ btn.disabled = false; btn.textContent = 'Zaloguj się'; });
}

function fbFriendlyError(code){
  const map = {
    'auth/invalid-email':'Nieprawidłowy adres e-mail.',
    'auth/user-not-found':'Nie znaleziono takiego konta.',
    'auth/wrong-password':'Złe hasło.',
    'auth/invalid-credential':'Złe dane logowania.',
    'auth/too-many-requests':'Zbyt wiele prób. Spróbuj ponownie za chwilę.',
  };
  return map[code] || 'Sprawdź e-mail i hasło.';
}

function fbDoLogout(){
  if(!confirm('Na pewno się wylogować?')) return;
  fbAuth.signOut();
}

// ── STAN LOGOWANIA ──
fbAuth.onAuthStateChanged(user => {
  const overlay = document.getElementById('login-overlay');
  const app = document.getElementById('main-app');
  if(user){
    fbCurrentUser = user;
    overlay.style.display = 'none';
    app.style.display = 'flex';
    fbSyncFromCloud();
  } else {
    fbCurrentUser = null;
    overlay.style.display = 'flex';
    app.style.display = 'none';
  }
});

// ── POBIERANIE Z CHMURY PO ZALOGOWANIU ──
async function fbSyncFromCloud(){
  if(!fbCurrentUser) return;
  fbSetStatus('⏳ Synchronizuję...');
  try {
    const [debtsSnap, impulseSnap, holdingsSnap] = await Promise.all([
      fbDb.collection('debts').where('ownerUid','==',fbCurrentUser.uid).get(),
      fbDb.collection('impulsePurchases').where('ownerUid','==',fbCurrentUser.uid).get(),
      fbDb.collection('holdings').doc(fbCurrentUser.uid).get()
    ]);

    if(!debtsSnap.empty){
      const debts = debtsSnap.docs.map(d=>{
        const data = d.data(); delete data.ownerUid;
        return { ...data, id: parseInt(d.id) };
      });
      saveDebtsData(debts);
      if(typeof migrateZusToBusinessRun==='function') migrateZusToBusinessRun();
      if(typeof applyRecurringExpenses==='function') applyRecurringExpenses();
    }
    if(!impulseSnap.empty){
      const impulses = impulseSnap.docs.map(d=>{
        const data = d.data(); delete data.ownerUid;
        return { ...data, id: parseInt(d.id) };
      });
      saveImpulseData(impulses);
    }
    let holdingsData = {};
    if(holdingsSnap.exists){
      holdingsData = holdingsSnap.data()||{};
      saveHoldingsData({ stocks: Number(holdingsData.stocks)||0, bitcoin: Number(holdingsData.bitcoin)||0 });
    }

    const restored = fbApplyCloudBudget(holdingsData);
    if(restored) return;

    // Odśwież widok, jeśli akurat na jednej z tych stron
    if(typeof curPage !== 'undefined'){
      if(curPage==='debts') renderDebts();
      if(curPage==='impulse') renderImpulse();
      if(curPage==='dashboard') renderDash();
      if(curPage==='expenses' && typeof renderExpenses==='function') renderExpenses();
      if(curPage==='subs' && typeof renderSubs==='function') renderSubs();
      if(curPage==='schedule' && typeof renderSchedule==='function') renderSchedule();
      if(curPage==='income' && typeof renderIncome==='function') renderIncome();
    }
    fbSetStatus('✓ Zsynchronizowano · ' + fbCurrentUser.email);
    fbPushBudget();
  } catch(e) {
    console.warn('Synchronizacja z chmury nieudana:', e.message);
    fbSetStatus('⚠️ Synchronizacja: ' + fbBudgetErr(e), true);
  }
}

const FB_BUDGET_EXTRA_KEYS = [
  'budzet_subs','budzet_holdings','budzet_limits','budzet_goals',
  'budzet_env','budzet_debts','budzet_impulse','budzet_advisor_chat',
  'budzet_theme','budzet_debt_strategy'
];

function fbIsDemoBudget(list){
  if(!Array.isArray(list) || !list.length) return true;
  if(list.some(t => t && t.cat==='Plan treningowy' && t.time)) return false;
  const months = list.map(t => String(t && t.month || ''));
  if(months.some(m => m && m!=='Kwiecień 2026' && m!=='Maj 2026')) return false;
  const names = list.map(t => String(t && t.name || ''));
  const seedHits = ['Temu.com','Plan treningowy — Kowalski','Plan treningowy — Nowak']
    .filter(n => names.includes(n)).length;
  return seedHits >= 2 && list.length <= 80;
}

function fbReadBudgetExtras(){
  const extras = {};
  FB_BUDGET_EXTRA_KEYS.forEach(k=>{
    const v = localStorage.getItem(k);
    if(v!=null) extras[k] = v;
  });
  return extras;
}

function fbWriteBudgetExtras(extras){
  if(!extras || typeof extras!=='object') return;
  FB_BUDGET_EXTRA_KEYS.forEach(k=>{
    if(typeof extras[k]==='string') localStorage.setItem(k, extras[k]);
  });
}

let fbBudgetTimer = null;
function fbPushBudget(){
  if(!fbCurrentUser) return;
  clearTimeout(fbBudgetTimer);
  fbBudgetTimer = setTimeout(fbPushBudgetNow, 600);
}

function fbBudgetErr(e){
  const msg = String((e && (e.message || e.code)) || e || '');
  if(/permission-denied|missing or insufficient permissions/i.test(msg)) return 'brak uprawnień do chmury';
  if(/unavailable|offline|Failed to get document because the client is offline/i.test(msg)) return 'offline';
  if(/too (large|big)|exceed|longer than/i.test(msg)) return 'kopia za duża';
  return msg.slice(0, 80) || 'błąd chmury';
}

async function fbPushBudgetNow(){
  if(!fbCurrentUser) return;
  let list = null;
  try { list = JSON.parse(localStorage.getItem('budzet_v3')||'null'); } catch(e){ return; }
  if(fbIsDemoBudget(list)) return;
  const payload = {
    ownerUid: fbCurrentUser.uid,
    budgetJson: JSON.stringify(list),
    budgetTxCount: Array.isArray(list) ? list.length : 0,
    budgetUpdatedAt: firebase.firestore.FieldValue.serverTimestamp()
  };
  try {
    await fbDb.collection('holdings').doc(fbCurrentUser.uid).set(
      { ...payload, budgetExtras: fbReadBudgetExtras() },
      { merge: true }
    );
    fbSetStatus('✓ Zapisano · kopia w chmurze');
  } catch(e){
    console.warn('Firestore (holdings/budget) błąd zapisu:', e.message);
    try {
      await fbDb.collection('holdings').doc(fbCurrentUser.uid).set(payload, { merge: true });
      fbSetStatus('✓ Zapisano · kopia budżetu w chmurze');
    } catch(e2){
      console.warn('Firestore (holdings/budget) drugi błąd:', e2.message);
      fbSetStatus('✓ Zapisano w przeglądarce · chmura: ' + fbBudgetErr(e2), true);
    }
  }
}

function fbApplyCloudBudget(hd){
  if(!hd || typeof hd.budgetJson!=='string' || !hd.budgetJson) return false;
  let cloudList = null;
  try { cloudList = JSON.parse(hd.budgetJson); } catch(e){ return false; }
  if(fbIsDemoBudget(cloudList)) return false;
  let local = null;
  try { local = JSON.parse(localStorage.getItem('budzet_v3')||'null'); } catch(e){}
  const localDemo = fbIsDemoBudget(local);
  const cloudN = Array.isArray(cloudList) ? cloudList.length : 0;
  const localN = Array.isArray(local) ? local.length : 0;
  if(!localDemo && localN >= cloudN) return false;
  localStorage.setItem('budzet_v3', hd.budgetJson);
  fbWriteBudgetExtras(hd.budgetExtras);
  fbSetStatus('✓ Przywrócono budżet z chmury');
  location.reload();
  return true;
}

// ── WYSYŁANIE ZMIAN DO CHMURY (wywoływane z index.html po każdym zapisie) ──
async function fbPushDebt(debt){
  if(!fbCurrentUser) return;
  try {
    await fbDb.collection('debts').doc(String(debt.id)).set({ ...debt, ownerUid: fbCurrentUser.uid, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
    fbSetStatus('✓ Zapisano w chmurze');
  } catch(e){ console.warn('Firestore (debts) błąd zapisu:', e.message); fbSetStatus('⚠️ Nie zapisano w chmurze (offline?)', true); }
}
async function fbDeleteDebt(id){
  if(!fbCurrentUser) return;
  try { await fbDb.collection('debts').doc(String(id)).delete(); } catch(e){ console.warn(e.message); }
}
async function fbPushImpulse(entry){
  if(!fbCurrentUser) return;
  try {
    await fbDb.collection('impulsePurchases').doc(String(entry.id)).set({ ...entry, ownerUid: fbCurrentUser.uid, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
    fbSetStatus('✓ Zapisano w chmurze');
  } catch(e){ console.warn('Firestore (impulsePurchases) błąd zapisu:', e.message); fbSetStatus('⚠️ Nie zapisano w chmurze (offline?)', true); }
}
async function fbDeleteImpulse(id){
  if(!fbCurrentUser) return;
  try { await fbDb.collection('impulsePurchases').doc(String(id)).delete(); } catch(e){ console.warn(e.message); }
}
async function fbPushHoldings(h){
  if(!fbCurrentUser) return;
  try {
    await fbDb.collection('holdings').doc(fbCurrentUser.uid).set({
      stocks: Number(h.stocks)||0,
      bitcoin: Number(h.bitcoin)||0,
      ownerUid: fbCurrentUser.uid,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    fbSetStatus('✓ Zapisano w chmurze');
  } catch(e){ console.warn('Firestore (holdings) błąd zapisu:', e.message); fbSetStatus('⚠️ Nie zapisano w chmurze (offline?)', true); }
}
