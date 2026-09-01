// ═══════════════════════════════════════════════════════════
// FIREBASE — AUTORYZACJA I SYNCHRONIZACJA (debts, impulsePurchases)
// ═══════════════════════════════════════════════════════════
// Podejście: localStorage pozostaje SZYBKĄ warstwą lokalną (apka
// działa i renderuje się dokładnie jak wcześniej, natychmiastowo).
// Firestore to warstwa synchronizacji w tle — przy każdym zapisie
// wysyłamy zmianę do chmury; przy logowaniu ściągamy najnowsze dane
// z chmury i nadpisujemy nimi localStorage.

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
    }
    if(!impulseSnap.empty){
      const impulses = impulseSnap.docs.map(d=>{
        const data = d.data(); delete data.ownerUid;
        return { ...data, id: parseInt(d.id) };
      });
      saveImpulseData(impulses);
    }
    if(holdingsSnap.exists){
      const hd = holdingsSnap.data()||{};
      saveHoldingsData({ stocks: Number(hd.stocks)||0, bitcoin: Number(hd.bitcoin)||0 });
    }

    // Odśwież widok, jeśli akurat na jednej z tych stron
    if(typeof curPage !== 'undefined'){
      if(curPage==='debts') renderDebts();
      if(curPage==='impulse') renderImpulse();
      if(curPage==='dashboard') renderDash();
    }
    fbSetStatus('✓ Zsynchronizowano · ' + fbCurrentUser.email);
  } catch(e) {
    console.warn('Synchronizacja z chmury nieudana:', e.message);
    fbSetStatus('⚠️ Brak synchronizacji (offline?)', true);
  }
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
    });
    fbSetStatus('✓ Zapisano w chmurze');
  } catch(e){ console.warn('Firestore (holdings) błąd zapisu:', e.message); fbSetStatus('⚠️ Nie zapisano w chmurze (offline?)', true); }
}
