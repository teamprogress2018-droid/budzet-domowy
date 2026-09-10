#!/usr/bin/env node
'use strict';
/** Przywracanie danych: składnia grafiku, kopia, odzysk tygodnia z zrzutu. */
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

ok('single cal-slot return', (html.match(/return `<div class="cal-slot/g) || []).length === 1);
ok('no leftover duplicate return', !/cs-name\$\{hourLabel\(h\)\} \$\{nm\}\$\{\(t\.withGuest[\s\S]{0,200}return `<div class="cal-slot/.test(html));
ok('save pushes budget', /function save\(\)\{[\s\S]*fbPushBudget/.test(html));
ok('backup UI', html.includes('Pobierz kopię') && html.includes('Wczytaj kopię') && html.includes('function downloadBudgetBackup'));
ok('cloud backup collection', sync.includes("collection('budgetBackups')") && sync.includes('function fbRestoreBudgetIfNeeded') && sync.includes('function fbIsDemoBudget'));
ok('never push demo', /if\(fbIsDemoBudget\(list\)\) return;/.test(sync));
ok('recovery helpers', html.includes('function applySeptemberGrafikRecovery') && html.includes('Magda Krawiec') && html.includes('Radosław Bąk'));
ok('loads fb-sync.js', /<script src="fb-sync\.js"><\/script>/.test(html));

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

const ctx = {
  data: [],
  schedDate: null,
  save() {},
  MONTHS_PL: ['Styczeń','Luty','Marzec','Kwiecień','Maj','Czerwiec','Lipiec','Sierpień','Wrzesień','Październik','Listopad','Grudzień'],
  localStorage: {
    _s: {},
    getItem(k){ return this._s[k] == null ? null : this._s[k]; },
    setItem(k,v){ this._s[k] = String(v); }
  },
  Date, String, Math, Number, parseInt, parseFloat, isNaN, JSON, Object, Array
};
function take(startName, endName) {
  const start = html.indexOf(startName);
  const end = html.indexOf(endName, start + startName.length);
  ok('take '+startName, start >= 0 && end > start);
  return html.slice(start, end);
}
vm.createContext(ctx);
vm.runInContext(
  take('function toISODate', 'function parseISODate') +
  take('function parseISODate', 'function isoToTxDate') +
  take('function isoToTxDate', 'function isoToMonthLabel') +
  take('function isoToMonthLabel', 'function txToISO') +
  take('function txToISO', 'function isTrainingIncome') +
  take('function isTrainingIncome', 'function isTrainingPlanned') +
  take('function scheduleClientName', 'function startOfISOWeek') +
  take('function clientKey', 'function lastTrainingAmtFor') +
  take('function hasTrainingAt', 'function timedWeekTrainings') +
  take('function applyBudgetBackupPayload', 'function loadBudgetBackupFile'),
  ctx
);

const slots = ctx.septemberGrafikRecoverySlots();
ok('18 recovered slots', slots.length === 18, 'got '+slots.length);
ok('tuesday oskar', slots.some(t => t.iso==='2026-09-01' && t.time==='14:00' && t.name.includes('Oskar') && t.amt===120 && t.src==='cash'));
ok('magda transfer', slots.some(t => t.name.includes('Magda Krawiec') && t.src==='bank' && t.amt===120));
ok('rafael split', slots.some(t => t.iso==='2026-09-01' && t.time==='20:00' && t.src==='split' && t.cashAmt===85 && t.bankAmt===85 && t.amt===170 && t.withGuest));
ok('karolina split', slots.some(t => t.name.includes('Karolina i Przemek') && t.src==='split' && t.amt===140));
ok('all planned', slots.every(t => t.planned===true && t.cat==='Plan treningowy' && t.month==='Wrzesień 2026'));

ctx.data = [];
ok('applies into empty', ctx.applySeptemberGrafikRecovery() === 18);
ok('sets week date', ctx.schedDate === '2026-09-01');
ok('second apply is noop', ctx.applySeptemberGrafikRecovery() === 0);
ok('no duplicates', ctx.data.filter(t => t.name.includes('Oskar')).length === 1);
ok('recovery flag set', ctx.localStorage.getItem('budzet_recovered_sept2026_w36') === '1');

ctx.localStorage._s = {};
ctx.schedDate = null;
ctx.data = [{ cat:'Plan treningowy', iso:'2026-09-08', time:'10:00', name:'Plan treningowy — Arek', amt:120 }];
ok('skips when september exists', ctx.applySeptemberGrafikRecovery() === 0);
ok('marks recovered if already present', ctx.localStorage.getItem('budzet_recovered_sept2026_w36') === '1');
ctx.data = [];
ok('flag blocks re-inject', ctx.applySeptemberGrafikRecovery() === 0);

ctx.data = [{ cat:'Plan treningowy', iso:'2026-09-08', time:'10:00', name:'Plan treningowy — Arek', amt:120 }];
const payload = ctx.collectBudgetBackup();
ok('backup has txs', Array.isArray(payload.keys.budzet_v3) && payload.keys.budzet_v3.length === 1);
ctx.localStorage._s = {};
ctx.applyBudgetBackupPayload(payload);
const restored = JSON.parse(ctx.localStorage.getItem('budzet_v3'));
ok('import writes array', Array.isArray(restored) && restored[0].name.includes('Arek'));
let threw=false;
try { ctx.applyBudgetBackupPayload({ v:1, keys:{ hello:1 } }); } catch(e){ threw=true; }
ok('import rejects junk', threw);

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
ok('demo empty', fbIsDemoBudget([]) && fbIsDemoBudget(null));
ok('demo seed-like', fbIsDemoBudget([
  {name:'Temu.com', month:'Kwiecień 2026'},
  {name:'Plan treningowy — Kowalski', month:'Maj 2026'},
  {name:'Plan treningowy — Nowak', month:'Maj 2026'}
]));
ok('real grafik not demo', !fbIsDemoBudget(slots));

if (failed) process.exit(1);
console.log('\nAll restore-budget tests passed');
