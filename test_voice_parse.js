#!/usr/bin/env node
'use strict';
/** voice-parse.js + przycisk 🎤: zdanie → pola formularza, bez samodzielnego zapisu. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const V = require('./voice-parse.js');
const TxCore = require('./tx-core.js');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
let failed = 0;
function ok(name, cond, extra) {
  if (!cond) { console.error('FAIL ' + name + (extra ? ' — ' + extra : '')); failed++; }
  else console.log('OK  ', name);
}

const NOW = new Date('2026-10-04T10:00:00Z');
const KW = { 'Spożywcze': ['biedronka', 'lidl', 'zabka', 'kaufland'], 'Paliwo': ['orlen'], 'Subskrypcje': ['netflix'] };
const P = (t, extra) => V.parseVoiceExpense(t, Object.assign({ now: NOW, merchantKeywords: KW }, extra || {}));
const same = (r, exp) => Object.keys(exp).every(k => JSON.stringify(r[k]) === JSON.stringify(exp[k]));
function check(name, text, exp) {
  const r = P(text);
  ok(name, same(r, exp), JSON.stringify(r));
}

// ── Parser ──
check('pełne zdanie z przykładu', 'Dodaj wydatek 126,50 zł, Biedronka, spożywcze, karta, dzisiaj',
  { amount: 126.5, merchant: 'Biedronka', category: 'Spożywcze', categoryGuessed: false, paymentSource: 'bank', date: 'dzisiaj', missing: [] });
check('zł + gr, gotówką, wczoraj', '126 zł 50 gr Lidl gotówką wczoraj',
  { amount: 126.5, merchant: 'Lidl', paymentSource: 'cash', date: 'wczoraj', category: 'Spożywcze', categoryGuessed: true });
check('zł bez gr', '126 zł 50 Kaufland karta', { amount: 126.5, merchant: 'Kaufland' });
check('kropka jako przecinek', '12.50 Żabka gotówka', { amount: 12.5, merchant: 'Żabka', paymentSource: 'cash' });
check('blik → bank, kategoria z nazwy', 'Orlen 250 zł blikiem', { amount: 250, paymentSource: 'bank', category: 'Paliwo', categoryGuessed: true });
check('data słownie', 'apteka 34,99 zdrowie karta 3 października', { amount: 34.99, merchant: 'Apteka', category: 'Zdrowie', date: '2026-10-03' });
check('data DD.MM nie jest kwotą', 'Biedronka 45 kartą 5.09', { amount: 45, date: '2026-09-05' });
check('data bez roku z przyszłości → zeszły rok', '20 grudnia Biedronka 30 zł karta', { date: '2025-12-20', amount: 30 });
check('kwota słownie', 'sto dwadzieścia sześć złotych pięćdziesiąt groszy Biedronka spożywcze gotówką',
  { amount: 126.5, merchant: 'Biedronka', category: 'Spożywcze', paymentSource: 'cash' });
check('tysiące słownie', 'dwa tysiące złotych czynsz dom przelew', { amount: 2000, category: 'Dom i mieszkanie', paymentSource: 'bank' });
check('liczba w nazwie zostaje', 'Trzy Korony 40 zł karta', { amount: 40, merchant: 'Trzy Korony' });
check('słowa-wypełniacze usunięte', 'zapłaciłem 19,99 za Netflix kartą', { amount: 19.99, merchant: 'Netflix', category: 'Subskrypcje' });
check('alias kategorii wielowyrazowy', '45 zł Pizzeria jedzenie na mieście karta', { category: 'Jedzenie poza domem', merchant: 'Pizzeria' });
check('brak kwoty', 'Biedronka spożywcze karta', { amount: null, missing: ['amount'] });
check('brak płatności zgłoszony', '20 zł Biedronka', { paymentSource: null, missing: ['paymentSource'] });
check('nieznana kategoria i sklep', '20 zł Zakład Fryzjerski karta', { category: null, missing: ['category'] });
check('pusty tekst', '', { amount: null, missing: ['amount', 'merchant', 'category', 'paymentSource'] });
ok('nazwa przycięta do 80 znaków', P('10 zł ' + 'abc '.repeat(40) + 'karta').merchant.length <= 80);

// Wynik parsera przechodzi przez wspólną walidację z PR fundamentu
const parsed = P('126,50 Biedronka spożywcze karta dzisiaj');
const norm = TxCore.normalizeExpense({ amount: parsed.amount, merchant: parsed.merchant, category: parsed.category,
  date: parsed.date, paymentSource: parsed.paymentSource, externalId: 'voice-test-0001' }, { now: NOW });
ok('parser → TxCore.normalizeExpense', norm.ok && norm.tx.amt === -126.5 && norm.tx.cat === 'Spożywcze' && norm.tx.src === 'bank',
  JSON.stringify(norm));

// ── index.html: wczytanie, UI, brak samodzielnego zapisu ──
ok('skrypty w kolejności tx-core → voice-parse → główny',
  /<script src="tx-core\.js"><\/script>\s*<script src="voice-parse\.js"><\/script>\s*<script>/.test(html));
ok('pole i przycisk 🎤', html.includes('id="q-voice-text"') && html.includes('id="q-voice-mic"') && html.includes('onclick="voiceListen()"'));
ok('rozpoznawanie po polsku', /rec\.lang='pl-PL'/.test(html));
const fillSrc = html.slice(html.indexOf('function voiceFillQuickAdd'), html.indexOf('let voiceRec=null'));
ok('voiceFillQuickAdd zapisuje tylko przez doQuickAdd', fillSrc.length > 500 && !/\bsave\(|data\.push|localStorage|fbPush/.test(fillSrc) &&
  (fillSrc.match(/doQuickAdd\(\)/g) || []).length === 1);
ok('auto zapis zablokowany dla stałych opłat i bez płatności', /const canAuto = auto && !v\.recurring && !autoRecurringName && \(p\.paymentSource \|\| v\.kind==='salary'\)/.test(fillSrc));
const listenSrc = html.slice(html.indexOf('function voiceListen'), html.indexOf('function isImageFile'));
ok('voiceListen nie zapisuje sam', listenSrc.length > 300 && !/\bsave\(|doQuickAdd\(|data\.push|localStorage|fbPush/.test(listenSrc));
ok('blokada podczas edycji wpisu', fillSrc.includes('txEditIdx!=null'));
ok('ostrzeżenie o duplikacie', fillSrc.includes('TxCore.findDuplicate(data'));
const undoSrc = html.slice(html.indexOf('function voiceUndo'), html.indexOf('function voiceFillQuickAdd'));
ok('Cofnij używa zwykłego delTx', /delTx\(idx\)/.test(undoSrc) && !/data\.splice|save\(/.test(undoSrc));
ok('override gotówki tylko dla treningu/wynagrodzenia', html.includes("(quickSrcOverride==='cash' && (type==='training'||type==='salary')) ? 'cash' : 'bank'"));
ok('override kasowany po zapisie i zmianie typu', /quickSrcOverride=null;\n  const viewing=curMonth;/.test(html) && /function quickTypeChange\(\)\{\n  quickSrcOverride=null;/.test(html));

const inline = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
const tmp = path.join(__dirname, '.tmp-inline-voice-check.js');
fs.writeFileSync(tmp, inline);
try {
  require('child_process').execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
  ok('index.html JS parses', true);
} catch (e) {
  ok('index.html JS parses', false, (e.stderr || e.message).toString().slice(0, 300));
}
try { fs.unlinkSync(tmp); } catch (e) {}

// voiceFormValues: parser → wartości pól formularza
const ctx = { TxCore: { parseDate: (d) => TxCore.parseDate(d, { now: NOW }) }, MONTHS_PL: ['Styczeń','Luty','Marzec','Kwiecień','Maj','Czerwiec','Lipiec','Sierpień','Wrzesień','Październik','Listopad','Grudzień'],
  Math, Number, String, isFinite };
vm.createContext(ctx);
vm.runInContext(html.slice(html.indexOf('function round2'), html.indexOf('function fmt(')) +
  html.slice(html.indexOf('const VOICE_TYPE_BY_KIND'), html.indexOf('const VOICE_FIELD_PL')), ctx);
const fv = ctx.voiceFormValues(P('126,50 Biedronka spożywcze karta dzisiaj'));
ok('formularz: wydatek kartą', fv.type === 'expense' && fv.name === 'Biedronka' && fv.amt === '126,50' && fv.cat === 'Spożywcze', JSON.stringify(fv));
ok('formularz: data i miesiąc', fv.date === '04.10.2026' && fv.month === 'Październik 2026', JSON.stringify(fv));
ok('formularz: gotówka → Wydatek gotówkowy', ctx.voiceFormValues(P('20 zł Lidl gotówka')).type === 'cash-exp');
ok('formularz: przyszła data → błąd', ctx.voiceFormValues({ amount: 5, merchant: 'X', date: '2026-12-01' }).dateError === 'future_date');

ok('formularz: trening gotówką → override cash', (() => { const x = ctx.voiceFormValues(P('trening Kowalski 120 gotówka')); return x.type === 'training' && x.srcOverride === 'cash' && x.name === 'Plan treningowy — Kowalski'; })());
ok('formularz: przychód gotówką → cash-inc', ctx.voiceFormValues(P('przychód 300 zł gotówką')).type === 'cash-inc' && ctx.voiceFormValues(P('przychód 300 zł gotówką')).cat === 'Przychód gotówkowy');
ok('formularz: przelew od → income', ctx.voiceFormValues(P('dostałem przelew od Patrycji 2000 zł')).type === 'income');

// ── Przychody i stałe opłaty w parserze ──
check('trening + klient + gotówka', 'trening Kowalski 120 gotówka',
  { kind: 'training', amount: 120, merchant: 'Plan treningowy — Kowalski', category: 'Plan treningowy', paymentSource: 'cash' });
check('za trening blikiem', 'za trening Oskar 150 zł blik', { kind: 'training', merchant: 'Plan treningowy — Oskar', paymentSource: 'bank' });
check('wypłata', 'wypłata 4500 zł przelew', { kind: 'salary', amount: 4500, category: 'Wynagrodzenie', merchant: 'Wynagrodzenie' });
check('przychód gotówką', 'przychód 300 zł gotówką', { kind: 'income', category: 'Przychód gotówkowy', paymentSource: 'cash', merchant: 'Przychód' });
check('przelew od kogoś = przychód', 'dostałem przelew od Patrycji 2000 zł', { kind: 'income', amount: 2000, merchant: 'Patrycji', category: 'Przychód bankowy' });
check('zwrot = przychód', 'zwrot z Allegro 59,99 przelew', { kind: 'income', merchant: 'Allegro' });
check('co miesiąc = stała opłata', 'Netflix 43 zł co miesiąc kartą', { kind: 'expense', recurring: true, merchant: 'Netflix', category: 'Subskrypcje' });
check('miesięcznie = stała opłata', 'czynsz 1800 zł miesięcznie przelew dom', { recurring: true, category: 'Dom i mieszkanie', merchant: 'Czynsz' });
check('zwykły wydatek nie jest stały', '126,50 Biedronka karta', { kind: 'expense', recurring: false });

// ── Decyzja: zapisz od razu / do zatwierdzenia (sztuczny DOM) ──
function makeDom() {
  const els = {};
  const el = (id, extra) => (els[id] = Object.assign({ id, value: '', textContent: '', className: '', checked: false, options: [],
    appendChild(c) { this.children = (this.children || []).concat([c]); } }, extra || {}));
  ['q-voice-text','q-name','q-amt','q-date','q-month','q-voice-status','q-recurring','q-voice-auto'].forEach(id => el(id));
  el('q-type', { value: 'expense' });
  el('q-cat');
  return els;
}
const fnSrc = ['const VOICE_TYPE_BY_KIND', 'function voiceListen'].reduce((a, b, i, arr) => i ? a : html.slice(html.indexOf(arr[0]), html.indexOf(arr[1])), '');
function runFill(text, opts, preData) {
  const els = makeDom();
  const calls = { quickAdd: 0, delTx: 0 };
  const TYPE_CATS = { expense: catCtxCats, 'cash-exp': catCtxCats, income: ['Przychód bankowy','Inne przychody'], 'cash-inc': ['Przychód gotówkowy'], salary: ['Wynagrodzenie'], training: ['Plan treningowy'] };
  const c = {
    document: { getElementById: id => els[id] || null, createElement: () => ({ set onclick(f) { this._f = f; } }), createTextNode: t => t },
    localStorage: { getItem: () => null, setItem() {} },
    TxCore: Object.assign({}, TxCore, { parseDate: d => TxCore.parseDate(d, { now: NOW }) }),
    VoiceParse: { parseVoiceExpense: (t, o) => V.parseVoiceExpense(t, Object.assign({}, o, { now: NOW })) },
    EXP_CATS: catCtxCats, CAT_KW: KW, MAX_TX_AMT: 99999999.99, txEditIdx: null, quickSrcOverride: null,
    MONTHS_PL: ctx.MONTHS_PL, data: (preData || []).slice(),
    quickTypeChange() { els['q-cat'].options = (TYPE_CATS[els['q-type'].value] || []).map(v => ({ value: v })); },
    looksLikeRecurringExpenseName: n => /^(zus|czynsz)\b/i.test(String(n || '').trim()),
    doQuickAdd() { calls.quickAdd++; c.lastSrcOverride = c.quickSrcOverride; c.data.push({ id: 'n' + calls.quickAdd, name: els['q-name'].value }); },
    delTx(i) { calls.delTx++; c.data.splice(i, 1); },
    Math, Number, String, isFinite, Object, Array, JSON
  };
  vm.createContext(c);
  vm.runInContext(html.slice(html.indexOf('function round2'), html.indexOf('function fmt(')) + fnSrc + ';this.__r = voiceFillQuickAdd(' + JSON.stringify(text) + ',' + JSON.stringify(opts || {}) + ');', c);
  return { r: c.__r, els, calls, c };
}
const catCtxCats = TxCore.EXPENSE_CATEGORIES;

let t = runFill('126,50 Biedronka spożywcze karta', { auto: true });
ok('auto: pełny wydatek zapisany raz', t.r.saved === true && t.calls.quickAdd === 1 && t.els['q-cat'].value === 'Spożywcze', JSON.stringify(t.r && t.r.problems));
ok('auto: status z przyciskiem Cofnij', /Zapisano wydatek: Biedronka −126,50 zł/.test(t.els['q-voice-status'].textContent) && (t.els['q-voice-status'].children || []).length === 2);
ok('auto: pole tekstowe wyczyszczone', t.els['q-voice-text'].value === '');
t = runFill('126,50 Biedronka spożywcze karta', { auto: false });
ok('auto wyłączone: tylko wypełnia', t.r.saved === false && t.calls.quickAdd === 0 && t.els['q-amt'].value === '126,50');
t = runFill('126,50 Biedronka spożywcze', { auto: true });
ok('brak płatności: nie zapisuje', t.r.saved === false && t.calls.quickAdd === 0);
t = runFill('Biedronka spożywcze karta', { auto: true });
ok('brak kwoty: nie zapisuje, prosi o uzupełnienie', t.calls.quickAdd === 0 && /Uzupełnij/.test(t.els['q-voice-status'].textContent));
t = runFill('Netflix 43 zł co miesiąc kartą', { auto: true });
ok('stała opłata: nie zapisuje, zaznacza Powtarzaj', t.calls.quickAdd === 0 && t.els['q-recurring'].checked === true);
t = runFill('czynsz 1800 zł przelew dom', { auto: true });
ok('czynsz/ZUS: nie zapisuje sam (doQuickAdd zrobiłby stałą opłatę)', t.calls.quickAdd === 0);
t = runFill('126,50 Biedronka spożywcze karta', { auto: true },
  [{ date: '04.10', name: 'Biedronka', cat: 'Spożywcze', amt: -126.5, month: 'Październik 2026', src: 'bank' }]);
ok('duplikat: nie zapisuje', t.r.duplicate === true && t.calls.quickAdd === 0 && t.c.data.length === 1);
t = runFill('trening Kowalski 120 gotówka', { auto: true });
ok('trening gotówką: zapis z override cash', t.r.saved && t.els['q-type'].value === 'training' && t.c.lastSrcOverride === 'cash');
t = runFill('wypłata 4500 zł', { auto: true });
ok('wypłata bez płatności: zapisuje (zawsze przelew)', t.r.saved === true && t.els['q-type'].value === 'salary');
t = runFill('przychód 300 zł gotówką', { auto: true });
ok('przychód gotówką: cash-inc', t.r.saved && t.els['q-type'].value === 'cash-inc' && t.els['q-cat'].value === 'Przychód gotówkowy');
t = runFill('20 grudnia 2026 Biedronka 30 zł karta', { auto: true });
ok('data z przyszłości: nie zapisuje', t.calls.quickAdd === 0 && /przyszłości/.test(t.els['q-voice-status'].textContent));

if (failed) {
  console.error('\n' + failed + ' failed');
  process.exit(1);
}
console.log('\nAll voice-parse tests passed');
