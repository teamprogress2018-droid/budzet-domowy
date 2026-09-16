#!/usr/bin/env node
'use strict';
/** Bilans, limity, zaokrąglenia, bezpieczny odczyt storage, edycja/usuwanie. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
let failed = 0;
function ok(name, cond, extra) {
  if (!cond) { console.error('FAIL ' + name + (extra ? ' — ' + extra : '')); failed++; }
  else console.log('OK  ', name);
}

ok('safe parse helper', html.includes('function safeJsonParse') && html.includes('function loadBudgetData'));
ok('persist month', html.includes('function persistCurMonth') && html.includes("budzet_cur_month"));
ok('limit dashboard', html.includes('id="d-limit-alert"') && html.includes('function overLimitCategories'));
ok('limit form data-cat', html.includes('data-cat="${cat}"') && /querySelectorAll\('#bud-limit-form input\[data-cat\]'\)/.test(html));
ok('edit tx', html.includes('function editTx') && html.includes('function cancelTxEdit') && html.includes('tx-edit'));
ok('reject zero / huge', html.includes('MAX_TX_AMT') && html.includes('Podaj kwotę większą od zera'));
ok('50/30/20 leftover', /const savings = round2\(Math\.max\(0, inc-exp\)\)/.test(html));
ok('cash split expense', html.includes('function cashExpenseOf'));
ok('week helper', html.includes('function weekData'));
ok('recurring still applied', html.includes('function applyRecurringExpenses') && html.includes('selMonth'));

const inline = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
ok('has inline script', inline.length > 1000);
const tmp = path.join(__dirname, '.tmp-inline-check.js');
fs.writeFileSync(tmp, inline);
try {
  execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
  ok('index.html JS parses', true);
} catch (e) {
  ok('index.html JS parses', false, (e.stderr || e.stdout || e.message).toString().slice(0, 400));
}
try { fs.unlinkSync(tmp); } catch (e) {}

function take(startName, endName) {
  const start = html.indexOf(startName);
  const end = html.indexOf(endName, start + startName.length);
  ok('take '+startName, start >= 0 && end > start);
  return start >= 0 && end > start ? html.slice(start, end) : '';
}

const store = {};
const ctx = {
  data: [],
  curMonth: 'Maj 2026',
  SEED: [],
  DEFAULT_LIMITS: { Spożywcze: 100, Paliwo: 50 },
  MONTHS_PL: ['Styczeń','Luty','Marzec','Kwiecień','Maj','Czerwiec','Lipiec','Sierpień','Wrzesień','Październik','Listopad','Grudzień'],
  MONTHS_PL_GEN_ASCII: ['stycznia','lutego','marca','kwietnia','maja','czerwca','lipca','sierpnia','wrzesnia','pazdziernika','listopada','grudnia'],
  localStorage: {
    getItem(k){ return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v){ store[k] = String(v); }
  },
  Math, Number, String, Date, JSON, Array, Object, parseFloat, parseInt, isFinite, isNaN,
  console
};
vm.createContext(ctx);
vm.runInContext(
  take('function safeJsonParse', 'function loadBudgetData') +
  take('function round2', 'function isIncome') +
  take('function isIncome', 'function getHoldings') +
  take('function persistCurMonth', 'function selMonth') +
  take('function mdata', 'function destroyChart') +
  take('function foldPl', 'function mIdx') +
  take('function categoryLimitStatus', 'function overLimitCategories') +
  take('function overLimitCategories', '// ═══════════════════════════════════════════════════\n// DASHBOARD') +
  take('function parseAmt', 'function fmtShort') +
  take('function getLimits', 'function setLimits') +
  'function setLimits(l){ localStorage.setItem("budzet_limits", JSON.stringify(l)); }\n' +
  take('function toISODate', 'function parseISODate') +
  take('function parseISODate', 'function isoToTxDate') +
  take('function txToISO', 'function isTrainingIncome') +
  take('function isoWeekKey', 'function txWeekKey') +
  take('function txWeekKey', 'function isMonthCovered') +
  take('function startOfISOWeek', 'function formatDayLabel'),
  ctx
);

ok('round2 0.1+0.2', ctx.round2(0.1+0.2) === 0.3);
ok('round2 nan', ctx.round2(NaN) === 0 && ctx.round2(Infinity) === 0);
ok('parseAmt comma', ctx.parseAmt('1 234,56') === 1234.56);
ok('parseAmt empty', Number.isNaN(ctx.parseAmt('')) && Number.isNaN(ctx.parseAmt('abc')));
ok('safe json', ctx.safeJsonParse('{', {ok:1}).ok === 1 && ctx.safeJsonParse('{"a":2}', null).a === 2);
ok('fmt nan', ctx.fmt(NaN) === '0,00 zł');

ctx.data = [
  {date:'01.05', name:'Pensja', cat:'Wynagrodzenie', amt:1000.10, month:'Maj 2026', src:'bank'},
  {date:'02.05', name:'Biedronka', cat:'Spożywcze', amt:-10.10, month:'Maj 2026', src:'cash'},
  {date:'03.05', name:'Orlen', cat:'Paliwo', amt:-20.20, month:'Maj 2026', src:'bank'},
  {date:'04.05', name:'Trening', cat:'Plan treningowy', amt:140, month:'Maj 2026', src:'split', cashAmt:70, bankAmt:70},
  {date:'05.05', name:'Plan', cat:'Plan treningowy', amt:120, month:'Maj 2026', src:'cash', planned:true},
  {date:'06.05', name:'Sklep', cat:'Spożywcze', amt:-0.10, month:'Czerwiec 2026', src:'bank'}
];
const may = ctx.mdata('Maj 2026');
ok('planned skipped', may.tx.every(t => t.planned !== true));
ok('income rounded', may.inc === 1140.1, String(may.inc));
ok('expense rounded', may.exp === 30.3, String(may.exp));
ok('balance', may.balance === 1109.8, String(may.balance));
ok('cash inc split', may.cashInc === 70, String(may.cashInc));
ok('cash exp only cash src', may.cashExp === 10.1, String(may.cashExp));

const before = ctx.mdata('Maj 2026').balance;
ctx.data = ctx.data.filter(t => t.name !== 'Orlen');
ok('delete recalculates', ctx.mdata('Maj 2026').balance === ctx.round2(before + 20.20));

ctx.data.push({date:'07.05', name:'Biedronka 2', cat:'Spożywcze', amt:-90, month:'Maj 2026', src:'bank'});
store.budzet_limits = JSON.stringify({ Spożywcze: 100, Paliwo: 50 });
const lim = ctx.categoryLimitStatus('Maj 2026', 'Spożywcze', 5);
ok('limit extra', lim && lim.actual === 105.1 && lim.over === true, JSON.stringify(lim));
const overs = ctx.overLimitCategories('Maj 2026');
ok('over list', overs.some(o => o.cat === 'Spożywcze'), JSON.stringify(overs));

ctx.data = [
  {date:'04.05', iso:'2026-05-04', name:'Wekly', cat:'Spożywcze', amt:-1.15, month:'Maj 2026', src:'bank'},
  {date:'05.05', iso:'2026-05-05', name:'Wekly2', cat:'Spożywcze', amt:-2.25, month:'Maj 2026', src:'bank'}
];
const week = ctx.weekData(ctx.isoWeekKey('2026-05-04'));
ok('week has tx', week.tx.length === 2 && week.exp === 3.4, JSON.stringify(week));

ctx.persistCurMonth();
ok('month saved', store.budzet_cur_month === 'Maj 2026');

if (failed) {
  console.error('\n' + failed + ' failed');
  process.exit(1);
}
console.log('\nAll budget-logic tests passed');
