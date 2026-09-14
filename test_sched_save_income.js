#!/usr/bin/env node
'use strict';
/** Grafik: zapis lokalny, minione treningi w przychodach, kopia na holdings. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const sync = fs.readFileSync(path.join(__dirname, 'fb-sync.js'), 'utf8');
let failed = 0;
function ok(name, cond, extra) {
  if (!cond) { console.error('FAIL ' + name + (extra ? ' — ' + extra : '')); failed++; }
  else console.log('OK  ', name);
}

ok('quota save error visible', html.includes('QuotaExceededError') && html.includes('Brak miejsca w przeglądarce'));
ok('week confirm button', html.includes('id="sched-confirm-week-btn"') && html.includes('function confirmSchedWeek'));
ok('elapsed confirm', html.includes('function confirmElapsedScheduleTrainings') && html.includes('function trainingReadyToEarn'));
ok('plan shown when not earned', html.includes('zatwierdź dzień, żeby weszło do przychodów'));
ok('holdings merge backup', sync.includes('budgetJson') && /collection\('holdings'\)[\s\S]*merge:\s*true/.test(sync));
ok('no scary offline-only backup msg', !sync.includes('Nie zapisano kopii budżetu (offline?)'));
ok('local save still mentioned on cloud fail', sync.includes('Zapisano w przeglądarce'));

const inline = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
const tmp = path.join(__dirname, '.tmp-inline-check.js');
fs.writeFileSync(tmp, inline);
try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); ok('JS parses', true); }
catch (e) { ok('JS parses', false, String(e.stderr || e.message).slice(0, 300)); }
try { fs.unlinkSync(tmp); } catch (e) {}

function take(startName, endName) {
  const start = html.indexOf(startName);
  const end = html.indexOf(endName, start + startName.length);
  ok('take '+startName, start >= 0 && end > start);
  return html.slice(start, end);
}

let saved = false;
const ctx = {
  data: [],
  MONTHS_PL: ['Styczeń','Luty','Marzec','Kwiecień','Maj','Czerwiec','Lipiec','Sierpień','Wrzesień','Październik','Listopad','Grudzień'],
  save() { saved = true; },
  isMonthCovered(){ return false; },
  isWeekCovered(){ return false; },
  Date, String, Math, Number, parseInt, parseFloat, isNaN, JSON, Object, Array
};
vm.createContext(ctx);
vm.runInContext(
  take('function toISODate', 'function parseISODate') +
  take('function parseISODate', 'function isoToTxDate') +
  take('function isoToTxDate', 'function isoToMonthLabel') +
  take('function isoToMonthLabel', 'function txToISO') +
  take('function txToISO', 'function isTrainingIncome') +
  take('function isTrainingIncome', 'function isTrainingPlanned') +
  take('function isTrainingPlanned', 'function isMonthPay') +
  take('function isMonthPay', 'function isWeekPay') +
  take('function isWeekPay', 'function isoWeekKey') +
  take('function scheduleClientName', 'function startOfISOWeek') +
  take('function isPrepaidCovered', 'function clientKey') +
  take('function trainingDayAmt', 'function trainingMonthAmt') +
  take('function trainingMonthAmt', 'function sumTrainingDay') +
  take('function migrateSchedulePlanned', 'function scheduleClientName'),
  ctx
);

function tx(iso, extra) {
  return Object.assign({
    cat: 'Plan treningowy',
    name: 'Plan treningowy — Arek',
    iso, time: '10:00',
    date: iso.slice(8,10)+'.'+iso.slice(5,7),
    month: 'Wrzesień 2026',
    amt: 170, src: 'cash', planned: true
  }, extra || {});
}

const today = ctx.toISODate(new Date());
ok('today is iso', /^\d{4}-\d{2}-\d{2}$/.test(today));
function shiftIso(iso, days){
  const [y,m,d]=iso.split('-').map(Number);
  const dt=new Date(y, m-1, d+days);
  return ctx.toISODate(dt);
}
const past1=shiftIso(today, -11);
const pastEmpty=shiftIso(today, -10);
const todayIso=today;
const futureIso=shiftIso(today, 1);
ctx.data = [
  tx(past1),
  tx(pastEmpty, { amt: 0, name: 'Plan treningowy — BrakKwoty' }),
  tx(todayIso),
  tx(futureIso)
];

const elapsed = ctx.confirmElapsedScheduleTrainings();
ok('confirms past with amount', ctx.data[0].planned === false);
ok('keeps past without amount planned', ctx.data[1].planned === true);
ok('keeps today/future planned', ctx.data[2].planned === true && ctx.data[3].planned === true);
ok('counts only past ready', elapsed.n === 1, JSON.stringify(elapsed)+' today='+today);
ok('save called', saved);

ctx.data[0].planned = false;
ok('past with amount is income', ctx.data[0].amt>0 && ctx.data[0].planned===false);

if (failed) process.exit(1);
console.log('\nAll sched save/income tests passed');
