#!/usr/bin/env node
'use strict';
/** tx-core.js: normalizacja wydatku (formularz / głos), duplikaty, idempotencja, zgodność z budzet_v3. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const TxCore = require('./tx-core.js');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
let failed = 0;
function ok(name, cond, extra) {
  if (!cond) { console.error('FAIL ' + name + (extra ? ' — ' + extra : '')); failed++; }
  else console.log('OK  ', name);
}
const codes = r => (r.errors || []).map(e => e.code);

// Stały "teraz": 4 października 2026, 12:00 w Warszawie.
const NOW = new Date('2026-10-04T10:00:00Z');
const OPTS = { now: NOW };

function voice(extra) {
  return Object.assign({
    amount: 126.50,
    merchant: 'Biedronka',
    category: 'spożywcze',
    date: 'dzisiaj',
    paymentSource: 'karta',
    note: '',
    externalId: 'chatgpt-call-0001'
  }, extra || {});
}

// ── Wczytanie w przeglądarce i zgodność z index.html ──
ok('index loads tx-core before inline script',
  /<script src="tx-core\.js"><\/script>\s*<script>/.test(html) &&
  html.indexOf('src="tx-core.js"') < html.indexOf('const EXP_CATS_PERSONAL'));
const browser = { self: {} };
browser.self = browser;
vm.createContext(browser);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'tx-core.js'), 'utf8'), browser);
ok('browser global TxCore', browser.TxCore && typeof browser.TxCore.applyExpense === 'function');

const catSrc = html.slice(html.indexOf('const EXP_CATS_PERSONAL'), html.indexOf('const TYPE_CATS'));
const catCtx = {};
vm.createContext(catCtx);
vm.runInContext(catSrc + ';this.EXP_CATS=EXP_CATS;', catCtx);
ok('categories match EXP_CATS in index.html',
  JSON.stringify(catCtx.EXP_CATS) === JSON.stringify(TxCore.EXPENSE_CATEGORIES),
  JSON.stringify(catCtx.EXP_CATS));

// ── 1. Prawidłowy wydatek ──
const r1 = TxCore.normalizeExpense(voice(), OPTS);
ok('valid expense ok', r1.ok, JSON.stringify(r1.errors));
const t1 = r1.tx || {};
ok('valid: budzet_v3 shape',
  t1.id === 'ext-chatgpt-call-0001' && t1.date === '04.10' && t1.iso === '2026-10-04' &&
  t1.name === 'Biedronka' && t1.cat === 'Spożywcze' && t1.amt === -126.5 &&
  t1.month === 'Październik 2026' && t1.src === 'bank' && t1.externalId === 'chatgpt-call-0001',
  JSON.stringify(t1));
ok('valid: empty note not stored', !('note' in t1));
ok('valid: string amount "126,50 zł"', TxCore.normalizeExpense(voice({ amount: '126,50 zł' }), OPTS).tx.amt === -126.5);
ok('valid: note kept', TxCore.normalizeExpense(voice({ note: ' zakupy  na weekend ' }), OPTS).tx.note === 'zakupy na weekend');
ok('valid: ISO date', TxCore.normalizeExpense(voice({ date: '2026-09-30' }), OPTS).tx.month === 'Wrzesień 2026');
ok('valid: wczoraj', TxCore.normalizeExpense(voice({ date: 'wczoraj' }), OPTS).tx.iso === '2026-10-03');

// ── 2. Kwota dodatnia jako wydatek → ujemna; ujemna zostaje ujemna ──
ok('positive → negative', TxCore.normalizeExpense(voice({ amount: 50 }), OPTS).tx.amt === -50);
ok('negative stays negative', TxCore.normalizeExpense(voice({ amount: -50 }), OPTS).tx.amt === -50);
ok('float noise 0.1+0.2 → -0.3', TxCore.normalizeExpense(voice({ amount: 0.1 + 0.2 }), OPTS).tx.amt === -0.3);

// ── 3. Brak / zła kwota ──
ok('missing amount', codes(TxCore.normalizeExpense(voice({ amount: undefined }), OPTS)).includes('missing_amount'));
ok('empty amount', codes(TxCore.normalizeExpense(voice({ amount: '' }), OPTS)).includes('missing_amount'));
ok('text amount', codes(TxCore.normalizeExpense(voice({ amount: 'sto' }), OPTS)).includes('invalid_amount'));
ok('zero amount', codes(TxCore.normalizeExpense(voice({ amount: 0 }), OPTS)).includes('zero_amount'));
ok('3 decimals rejected', codes(TxCore.normalizeExpense(voice({ amount: 12.345 }), OPTS)).includes('invalid_amount'));
ok('huge amount', codes(TxCore.normalizeExpense(voice({ amount: 1e9 }), OPTS)).includes('amount_too_large'));
ok('NaN / Infinity', codes(TxCore.normalizeExpense(voice({ amount: Infinity }), OPTS)).includes('invalid_amount'));

// ── 4. Nieprawidłowa data ──
ok('invalid date text', codes(TxCore.normalizeExpense(voice({ date: 'kiedyś' }), OPTS)).includes('invalid_date'));
ok('impossible date 2026-02-30', codes(TxCore.normalizeExpense(voice({ date: '2026-02-30' }), OPTS)).includes('invalid_date'));
ok('future date', codes(TxCore.normalizeExpense(voice({ date: '2026-10-05' }), OPTS)).includes('future_date'));
ok('too old date', codes(TxCore.normalizeExpense(voice({ date: '2020-01-01' }), OPTS)).includes('date_too_old'));
// 23:30 UTC 4.10 = 01:30 5.10 w Warszawie → "dzisiaj" to 5.10, nie 4.10
const late = TxCore.normalizeExpense(voice(), { now: new Date('2026-10-04T23:30:00Z') });
ok('today uses Europe/Warsaw', late.tx && late.tx.iso === '2026-10-05', late.tx && late.tx.iso);

// ── 5. Kategoria ──
ok('unknown category', codes(TxCore.normalizeExpense(voice({ category: 'Kasyno' }), OPTS)).includes('unknown_category'));
ok('missing category', codes(TxCore.normalizeExpense(voice({ category: '' }), OPTS)).includes('missing_category'));
ok('category without diacritics', TxCore.normalizeExpense(voice({ category: 'spozywcze' }), OPTS).tx.cat === 'Spożywcze');
ok('income category rejected for expense', codes(TxCore.normalizeExpense(voice({ category: 'Wynagrodzenie' }), OPTS)).includes('unknown_category'));
ok('custom category list', TxCore.normalizeExpense(voice({ category: 'Wakacje' }), Object.assign({ categories: ['Wakacje'] }, OPTS)).tx.cat === 'Wakacje');

// ── 6. Źródło cash / bank ──
ok('gotówka → cash', TxCore.normalizeExpense(voice({ paymentSource: 'gotówka' }), OPTS).tx.src === 'cash');
ok('cash → cash', TxCore.normalizeExpense(voice({ paymentSource: 'cash' }), OPTS).tx.src === 'cash');
ok('karta → bank', TxCore.normalizeExpense(voice({ paymentSource: 'Kartą' }), OPTS).tx.src === 'bank');
ok('blik → bank', TxCore.normalizeExpense(voice({ paymentSource: 'BLIK' }), OPTS).tx.src === 'bank');
ok('split rejected', codes(TxCore.normalizeExpense(voice({ paymentSource: 'split' }), OPTS)).includes('unknown_payment_source'));
ok('missing source', codes(TxCore.normalizeExpense(voice({ paymentSource: undefined }), OPTS)).includes('missing_payment_source'));

// ── 7. externalId i bezpieczeństwo pól ──
ok('missing externalId', codes(TxCore.normalizeExpense(voice({ externalId: undefined }), OPTS)).includes('missing_external_id'));
ok('bad externalId', codes(TxCore.normalizeExpense(voice({ externalId: 'a b/../c' }), OPTS)).includes('invalid_external_id'));
ok('form mode without externalId', TxCore.normalizeExpense(voice({ externalId: undefined }),
  Object.assign({ requireExternalId: false, makeId: () => 42 }, OPTS)).tx.id === 42);
const inj = TxCore.normalizeExpense(voice({ planned: true, debtId: 7, recurringId: 'x', amt: 999, id: 'hack', src: 'split' }), OPTS).tx;
ok('extra input fields ignored', inj && !('planned' in inj) && !('debtId' in inj) && !('recurringId' in inj) &&
  inj.amt === -126.5 && inj.id === 'ext-chatgpt-call-0001' && inj.src === 'bank', JSON.stringify(inj));
ok('control chars stripped', TxCore.normalizeExpense(voice({ merchant: 'Bied\u0000ronka\n630' }), OPTS).tx.name === 'Bied ronka 630');
ok('long name rejected', codes(TxCore.normalizeExpense(voice({ merchant: 'x'.repeat(81) }), OPTS)).includes('name_too_long'));
ok('non-object input', codes(TxCore.normalizeExpense('Dodaj 126 zł', OPTS)).includes('invalid_input'));
ok('income type rejected', codes(TxCore.normalizeExpense(voice({ type: 'income' }), OPTS)).includes('unsupported_type'));

// ── 8. Zachowanie istniejących danych budzet_v3 ──
const existing = [
  { date:'02.05', name:'Biedronka', cat:'Spożywcze', amt:-10.10, month:'Maj 2026', src:'cash' },                    // stary rekord bez id
  { id: 1714000000000, date:'03.05', iso:'2026-05-03', name:'Orlen', cat:'Paliwo', amt:-20.20, month:'Maj 2026', src:'bank' },
  { id:'rec-5-2026-10', date:'01.10', iso:'2026-10-01', name:'Netflix', cat:'Subskrypcje', amt:-43, month:'Październik 2026', src:'bank', recurringId:5 },
  { id:'recov-2026-09-01-14:00-oskar', date:'01.09', iso:'2026-09-01', time:'14:00', name:'Plan treningowy — Oskar', cat:'Plan treningowy', amt:120, month:'Wrzesień 2026', src:'split', cashAmt:60, bankAmt:60, planned:true }
];
const snapshot = JSON.stringify(existing);
const a1 = TxCore.applyExpense(existing, voice(), OPTS);
ok('apply: added', a1.status === 'added' && a1.list.length === existing.length + 1, a1.status);
ok('apply: input list not mutated', JSON.stringify(existing) === snapshot && existing.length === 4);
ok('apply: old records untouched and same objects', existing.every((t, i) => a1.list[i] === t));
ok('apply: new record at end', a1.list[a1.list.length - 1] === a1.tx);
ok('apply: serializes like budzet_v3', Array.isArray(JSON.parse(JSON.stringify(a1.list))));
ok('apply: non-array budget refused', TxCore.applyExpense(null, voice(), OPTS).status === 'invalid' &&
  codes(TxCore.applyExpense({}, voice(), OPTS)).includes('invalid_budget'));
const bad = TxCore.applyExpense(existing, voice({ amount: '' }), OPTS);
ok('apply: invalid returns same list', bad.status === 'invalid' && bad.list === existing);

// ── 9. Ponowienie tego samego externalId (idempotencja) ──
const a2 = TxCore.applyExpense(a1.list, voice(), OPTS);
ok('retry same externalId → duplicate', a2.status === 'duplicate' && a2.duplicate.reason === 'externalId');
ok('retry keeps list unchanged', a2.list === a1.list && a2.list.length === 5);
ok('retry returns existing tx', a2.tx === a1.tx);
const a2b = TxCore.applyExpense(a1.list, voice({ amount: 999, merchant: 'Inny sklep' }), OPTS);
ok('same externalId, different data → still duplicate', a2b.status === 'duplicate' && a2b.list.length === 5);
// po zapisie i ponownym wczytaniu z localStorage (JSON) też wykrywa
const reloaded = JSON.parse(JSON.stringify(a1.list));
ok('retry after JSON reload → duplicate', TxCore.applyExpense(reloaded, voice(), OPTS).status === 'duplicate');

// ── 10. Próba duplikatu (inny externalId, ta sama transakcja) ──
const a3 = TxCore.applyExpense(a1.list, voice({ externalId: 'chatgpt-call-0002' }), OPTS);
ok('same purchase new externalId → duplicate (fingerprint)', a3.status === 'duplicate' && a3.duplicate.reason === 'fingerprint');
const legacyDup = TxCore.applyExpense(existing, voice({ amount: 10.10, merchant: 'Biedronka', date: '2026-05-02',
  paymentSource: 'gotówka', externalId: 'chatgpt-call-0003' }), { now: new Date('2026-05-10T10:00:00Z') });
ok('duplicate of legacy record without id', legacyDup.status === 'duplicate' && legacyDup.duplicate.reason === 'fingerprint');
const a4 = TxCore.applyExpense(a1.list, voice({ externalId: 'chatgpt-call-0002' }), Object.assign({ allowFingerprintDuplicate: true }, OPTS));
ok('confirmed second identical purchase allowed', a4.status === 'added' && a4.list.length === 6);
ok('different amount not duplicate', TxCore.applyExpense(a1.list, voice({ amount: 126.51, externalId: 'chatgpt-call-0004' }), OPTS).status === 'added');

if (failed) {
  console.error('\n' + failed + ' failed');
  process.exit(1);
}
console.log('\nAll tx-core tests passed');
