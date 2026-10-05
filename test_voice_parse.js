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
ok('voiceFillQuickAdd nie zapisuje sam', fillSrc.length > 500 && !/\bsave\(|doQuickAdd\(|data\.push|localStorage|fbPush/.test(fillSrc));
const listenSrc = html.slice(html.indexOf('function voiceListen'), html.indexOf('function isImageFile'));
ok('voiceListen nie zapisuje sam', listenSrc.length > 300 && !/\bsave\(|doQuickAdd\(|data\.push|localStorage|fbPush/.test(listenSrc));
ok('blokada podczas edycji wpisu', fillSrc.includes('txEditIdx!=null'));
ok('ostrzeżenie o duplikacie', fillSrc.includes('TxCore.findDuplicate(data'));

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
  html.slice(html.indexOf('function voiceFormValues'), html.indexOf('const VOICE_FIELD_PL')), ctx);
const fv = ctx.voiceFormValues(P('126,50 Biedronka spożywcze karta dzisiaj'));
ok('formularz: wydatek kartą', fv.type === 'expense' && fv.name === 'Biedronka' && fv.amt === '126,50' && fv.cat === 'Spożywcze', JSON.stringify(fv));
ok('formularz: data i miesiąc', fv.date === '04.10.2026' && fv.month === 'Październik 2026', JSON.stringify(fv));
ok('formularz: gotówka → Wydatek gotówkowy', ctx.voiceFormValues(P('20 zł Lidl gotówka')).type === 'cash-exp');
ok('formularz: przyszła data → błąd', ctx.voiceFormValues({ amount: 5, merchant: 'X', date: '2026-12-01' }).dateError === 'future_date');

if (failed) {
  console.error('\n' + failed + ' failed');
  process.exit(1);
}
console.log('\nAll voice-parse tests passed');
