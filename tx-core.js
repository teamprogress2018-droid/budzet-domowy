// ═══════════════════════════════════════════════════════════
// TX-CORE — normalizacja i walidacja transakcji (bez UI)
// ═══════════════════════════════════════════════════════════
// Czysta logika, bez DOM, localStorage i Firebase. Działa w przeglądarce
// (window.TxCore) i w Node (require('./tx-core.js')), więc ten sam kod może
// sprawdzać wpis z formularza, z komendy głosowej i (w przyszłości) na backendzie.
//
// Zasady:
// - wynik jest zgodny z budzet_v3: {id,date,iso,name,cat,amt,month,src,...}
// - wydatek zawsze ma ujemne amt,
// - pola rekordu budujemy jawnie; nieznane pola z wejścia są ignorowane
//   (np. nie da się przemycić planned/debtId/recurringId),
// - funkcje nigdy nie modyfikują przekazanej listy — zwracają nową tablicę,
//   w której istniejące rekordy są tymi samymi obiektami,
// - idempotencja: externalId → id 'ext-<externalId>', ponowienie = duplikat.
(function(root, factory){
  const api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.TxCore = api;
})(typeof self !== 'undefined' ? self : this, function(){
  'use strict';

  const VERSION = 1;
  const TIME_ZONE = 'Europe/Warsaw';
  const MAX_AMOUNT = 99999999.99;       // jak MAX_TX_AMT w index.html
  const NAME_MAX = 80;
  const NOTE_MAX = 200;
  const DEFAULT_MAX_PAST_DAYS = 366;
  const EXTERNAL_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;

  const MONTHS_PL = ['Styczeń','Luty','Marzec','Kwiecień','Maj','Czerwiec','Lipiec','Sierpień','Wrzesień','Październik','Listopad','Grudzień'];

  // Musi być zgodne z EXP_CATS w index.html (pilnuje tego test_tx_core.js).
  const EXPENSE_CATEGORIES = [
    'Spożywcze','Paliwo','Jedzenie poza domem','Zakupy online','Sport i hobby',
    'Edukacja','Dom i mieszkanie','Zdrowie','Subskrypcje','Kosmetyki',
    'Telefon/TV/internet','Opłaty bankowe','Transport/parking','Telefon dziecka',
    'Spłata długu','Prezenty/różne','Inne',
    'Prowadzenie firmy','Koszty firmowe'
  ];

  const SOURCE_ALIASES = {
    cash: ['cash','gotowka','gotowke','gotowkowo'],
    bank: ['bank','card','karta','karte','karty','przelew','transfer','blik','konto']
  };

  const ERR = {
    invalid_input:          'Nieprawidłowe dane wejściowe.',
    invalid_budget:         'Budżet nie jest listą transakcji — nic nie zapisano.',
    unsupported_type:       'Obsługiwane są tylko wydatki.',
    missing_amount:         'Brak kwoty.',
    invalid_amount:         'Nieprawidłowa kwota.',
    zero_amount:            'Kwota musi być większa od zera.',
    amount_too_large:       'Kwota jest za duża.',
    missing_name:           'Brak nazwy sklepu / opisu.',
    name_too_long:          'Nazwa jest za długa.',
    note_too_long:          'Notatka jest za długa.',
    missing_category:       'Brak kategorii.',
    unknown_category:       'Nieznana kategoria.',
    invalid_date:           'Nieprawidłowa data.',
    future_date:            'Data nie może być z przyszłości.',
    date_too_old:           'Data jest za stara.',
    missing_payment_source: 'Brak źródła płatności (gotówka / karta).',
    unknown_payment_source: 'Nieznane źródło płatności.',
    missing_external_id:    'Brak externalId — potrzebny do ochrony przed duplikatami.',
    invalid_external_id:    'Nieprawidłowy externalId.'
  };

  function err(field, code){ return { field, code, message: ERR[code] || code }; }

  function fold(s){
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(/ł/g, 'l')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function round2(n){
    const x = Number(n);
    if(!isFinite(x)) return 0;
    return Math.round(x * 100) / 100;
  }

  function cleanText(v){
    return String(v == null ? '' : v)
      .replace(/[\u0000-\u001F\u007F]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // "126,50", "126.50 zł", "1 234,56", 126.5 → liczba; inaczej NaN.
  function parseAmount(v){
    if(typeof v === 'number') return isFinite(v) ? v : NaN;
    if(typeof v !== 'string') return NaN;
    let s = v.replace(/ /g, ' ').trim().toLowerCase().replace(/\s*(zł|zl|pln)$/, '').replace(/\s+/g, '');
    if(!s) return NaN;
    if(s.includes(',') && s.includes('.')) s = s.replace(/\./g, '');
    s = s.replace(',', '.');
    if(!/^[+-]?\d+(\.\d+)?$/.test(s)) return NaN;
    return parseFloat(s);
  }

  // Więcej niż grosze (np. 12.345) to błąd; szum float (0.1+0.2) nie.
  function hasSubCent(n){
    const c = Math.abs(n) * 100;
    return Math.abs(c - Math.round(c)) > 1e-6;
  }

  // ── DATY (strefa Europe/Warsaw, niezależnie od strefy serwera) ──
  function todayISO(now, timeZone){
    const d = now instanceof Date ? now : new Date();
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: timeZone || TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(d);
    } catch(e){
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
  }
  function isoToUTC(iso){
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if(!m) return null;
    const y = +m[1], mo = +m[2], d = +m[3];
    const t = Date.UTC(y, mo - 1, d);
    const back = new Date(t);
    if(back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
    return t;
  }
  function addDaysISO(iso, days){
    const t = isoToUTC(iso);
    if(t == null) return null;
    return new Date(t + days * 86400000).toISOString().slice(0, 10);
  }
  function isoParts(iso){
    const [y, m, d] = iso.split('-');
    return { iso, date: d + '.' + m, month: MONTHS_PL[parseInt(m, 10) - 1] + ' ' + y };
  }

  // Zwraca { iso } albo { error }.
  function parseDate(v, opts){
    const o = opts || {};
    const today = todayISO(o.now, o.timeZone);
    const raw = fold(v);
    let iso = null;
    if(v == null || raw === '' || raw === 'dzisiaj' || raw === 'dzis' || raw === 'today') iso = today;
    else if(raw === 'wczoraj' || raw === 'yesterday') iso = addDaysISO(today, -1);
    else if(raw === 'przedwczoraj') iso = addDaysISO(today, -2);
    else if(typeof v === 'string'){
      const s = v.trim();
      let m;
      if((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) iso = s;
      else if((m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s))) iso = m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
    }
    if(!iso || isoToUTC(iso) == null) return { error: 'invalid_date' };
    if(iso > today) return { error: 'future_date' };
    const maxPast = o.maxPastDays == null ? DEFAULT_MAX_PAST_DAYS : o.maxPastDays;
    if(iso < addDaysISO(today, -maxPast)) return { error: 'date_too_old' };
    return { iso };
  }

  function resolveCategory(v, categories){
    const list = Array.isArray(categories) && categories.length ? categories : EXPENSE_CATEGORIES;
    const key = fold(v);
    if(!key) return null;
    return list.find(c => fold(c) === key) || null;
  }

  function resolveSource(v){
    const key = fold(v);
    if(!key) return null;
    if(SOURCE_ALIASES.cash.includes(key)) return 'cash';
    if(SOURCE_ALIASES.bank.includes(key)) return 'bank';
    return null;
  }

  // ── NORMALIZACJA WYDATKU (formularz / głos) ──
  // input: { amount, merchant|name, category, date, paymentSource, note, externalId, type? }
  // → { ok, errors, tx }
  function normalizeExpense(input, opts){
    const o = opts || {};
    const errors = [];
    if(!input || typeof input !== 'object' || Array.isArray(input)){
      return { ok: false, errors: [err('input', 'invalid_input')], tx: null };
    }

    if(input.type != null && fold(input.type) !== 'expense' && fold(input.type) !== 'wydatek'){
      errors.push(err('type', 'unsupported_type'));
    }

    let amt = null;
    if(input.amount == null || input.amount === '') errors.push(err('amount', 'missing_amount'));
    else {
      const n = parseAmount(input.amount);
      if(!isFinite(n)) errors.push(err('amount', 'invalid_amount'));
      else if(hasSubCent(n)) errors.push(err('amount', 'invalid_amount'));
      else if(n === 0) errors.push(err('amount', 'zero_amount'));
      else if(Math.abs(n) > MAX_AMOUNT) errors.push(err('amount', 'amount_too_large'));
      else amt = -round2(Math.abs(n));
    }

    const name = cleanText(input.merchant != null ? input.merchant : input.name);
    if(!name) errors.push(err('merchant', 'missing_name'));
    else if(name.length > NAME_MAX) errors.push(err('merchant', 'name_too_long'));

    let cat = null;
    if(input.category == null || cleanText(input.category) === '') errors.push(err('category', 'missing_category'));
    else {
      cat = resolveCategory(input.category, o.categories);
      if(!cat) errors.push(err('category', 'unknown_category'));
    }

    const d = parseDate(input.date, o);
    if(d.error) errors.push(err('date', d.error));

    let src = null;
    if(input.paymentSource == null || cleanText(input.paymentSource) === '') errors.push(err('paymentSource', 'missing_payment_source'));
    else {
      src = resolveSource(input.paymentSource);
      if(!src) errors.push(err('paymentSource', 'unknown_payment_source'));
    }

    const note = cleanText(input.note);
    if(note.length > NOTE_MAX) errors.push(err('note', 'note_too_long'));

    const requireExternalId = o.requireExternalId !== false;
    const externalId = input.externalId == null ? '' : String(input.externalId).trim();
    if(!externalId){ if(requireExternalId) errors.push(err('externalId', 'missing_external_id')); }
    else if(!EXTERNAL_ID_RE.test(externalId)) errors.push(err('externalId', 'invalid_external_id'));

    if(errors.length) return { ok: false, errors, tx: null };

    const parts = isoParts(d.iso);
    const tx = {
      id: externalId ? 'ext-' + externalId : (o.makeId ? o.makeId() : Date.now()),
      date: parts.date,
      iso: parts.iso,
      name,
      cat,
      amt,
      month: parts.month,
      src
    };
    if(note) tx.note = note;
    if(externalId) tx.externalId = externalId;
    if(o.origin) tx.origin = String(o.origin);
    return { ok: true, errors: [], tx };
  }

  // Ten sam klucz co import wyciągu i paragon w index.html: miesiąc|data|nazwa|kwota.
  function txFingerprint(t){
    if(!t) return '';
    return fold(t.month) + '|' + String(t.date || '') + '|' + fold(t.name) + '|' + round2(t.amt).toFixed(2);
  }

  function findDuplicate(list, tx){
    if(!Array.isArray(list) || !tx) return null;
    if(tx.externalId){
      const hit = list.find(t => t && (t.externalId === tx.externalId || (tx.id != null && t.id === tx.id)));
      if(hit) return { reason: 'externalId', existing: hit };
    }
    const fp = txFingerprint(tx);
    const same = list.find(t => t && txFingerprint(t) === fp);
    if(same) return { reason: 'fingerprint', existing: same };
    return null;
  }

  // Dopisuje wydatek do kopii listy budzet_v3. Nigdy nie usuwa ani nie zmienia
  // istniejących rekordów. Ponowienie z tym samym externalId → 'duplicate'.
  // → { status: 'added'|'duplicate'|'invalid', list, tx, duplicate, errors }
  function applyExpense(list, input, opts){
    const o = opts || {};
    if(!Array.isArray(list)){
      return { status: 'invalid', list, tx: null, duplicate: null, errors: [err('budget', 'invalid_budget')] };
    }
    const res = normalizeExpense(input, o);
    if(!res.ok) return { status: 'invalid', list, tx: null, duplicate: null, errors: res.errors };
    const dup = findDuplicate(list, res.tx);
    if(dup && (dup.reason === 'externalId' || !o.allowFingerprintDuplicate)){
      return { status: 'duplicate', list, tx: dup.existing, duplicate: dup, errors: [] };
    }
    return { status: 'added', list: list.concat([res.tx]), tx: res.tx, duplicate: null, errors: [] };
  }

  return {
    VERSION,
    TIME_ZONE,
    MAX_AMOUNT,
    EXPENSE_CATEGORIES: EXPENSE_CATEGORIES.slice(),
    parseAmount,
    parseDate,
    todayISO,
    resolveCategory,
    resolveSource,
    normalizeExpense,
    txFingerprint,
    findDuplicate,
    applyExpense
  };
});
