#!/usr/bin/env node
/** Skan One Calendar → grafik: helpery i UI. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
let failed = 0;
function ok(name, cond) {
  if (!cond) { console.error('FAIL', name); failed++; }
  else console.log('OK  ', name);
}
function eq(name, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) { console.error('FAIL '+name+'\n  got '+g+'\n  want '+w); failed++; }
  else console.log('OK  ', name);
}

ok('scan UI', html.includes('id="sched-cal-camera"') && html.includes('id="sched-cal-scan-card"') && html.includes('Zrzut z kalendarza (One Calendar)'));
ok('paste + apply', html.includes('function pasteSchedCalendar') && html.includes('function applySchedCalImport'));
ok('drop on scan card', html.includes("getElementById('sched-cal-scan-card')") && html.includes("scanSchedCalendarBlob"));
ok('presence review no amount', html.includes('id="sched-cal-people"') && html.includes('Dodaj obecność do grafiku') && !html.includes('data-f="amt"'));
ok('people once', html.includes('function uniqueSchedCalPeople') && html.includes('function fillEmptyPlansForClient') && html.includes('function renameSchedCalPerson'));
ok('person 1 or 2 + pay', html.includes('setSchedCalPersonGuest') && html.includes('setSchedCalPersonPay') && html.includes('💵+🏦 Oba') && html.includes('1 osoba') && html.includes('2 osoby'));
ok('split always shown', html.includes("id=\"sched-pay-split\"") && html.includes("onclick=\"setSchedPay('split')\"") && !/sched-pay-split[\s\S]{0,80}display:none/.test(html));
ok('import amt 0', html.includes("amt: 0") && html.includes('function insertSchedulePlan'));
ok('training includes 0-amt plan', /function isTrainingIncome\(t\)\{\s*return t && t\.cat==='Plan treningowy';\s*\}/.test(html));
ok('confirm blocks missing amt', html.includes('Najpierw wpisz kwotę'));
ok('bind paste on schedule', html.includes('bindSchedCalImport'));

const start = html.indexOf('function snapSchedHour');
const end = html.indexOf('function fileToJpegDataUrl');
ok('helpers present', start > 0 && end > start);
const slice = html.slice(html.indexOf('const DAYS_PL'), html.indexOf('let schedDate'));
const helpers = html.slice(start, end);
const ctx = {
  SCHED_HOURS: [6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23],
  MONTHS_PL_GEN: ['stycznia','lutego','marca','kwietnia','maja','czerwca','lipca','sierpnia','września','października','listopada','grudnia'],
  console
};
ctx.hourLabel = function(h){ return String(h).padStart(2,'0')+':00'; };
ctx.toISODate = function(d){
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
};
ctx.parseISODate = function(iso){
  const [y,m,d]=(iso||'').split('-').map(Number);
  return new Date(y, (m||1)-1, d||1);
};
ctx.clientKey = function(name){ return String(name||'').trim().toLowerCase(); };
vm.createContext(ctx);
vm.runInContext(helpers, ctx);

eq('snap 8:30 floors', ctx.snapSchedHour('8:30'), '08:00');
eq('snap 8:50 rounds up', ctx.snapSchedHour('8:50'), '09:00');
eq('snap dotted time', ctx.snapSchedHour('18.00'), '18:00');
eq('snap rejects date', ctx.snapSchedHour('10.09'), '');
eq('clean strips trening', ctx.cleanSchedClientName('Trening Arek'), 'Arek');
eq('normalize iso', ctx.normalizeSchedCalEvent({date:'2026-09-10', time:'07:00', name:'Ola'}).iso, '2026-09-10');
eq('normalize time', ctx.normalizeSchedCalEvent({date:'2026-09-10', time:'07:15', name:'Ola'}).time, '07:00');
eq('dd.mm date', ctx.normalizeSchedCalEvent({date:'10.09.2026', time:'18:00', name:'Jan'}, '2026-09-09').iso, '2026-09-10');
eq('ocr line', ctx.parseCalendarOcrText('10.09.2026 18:00 Arek\n11.09 09:00 Trening Ola', '2026-09-09').map(e=>e.name+e.time), ['Arek18:00','Ola09:00']);
eq('ocr range start', ctx.parseCalendarOcrText('10.09.2026 18:00-19:00 Arek', '2026-09-09').map(e=>e.name+e.time+'@'+e.iso), ['Arek18:00@2026-09-10']);
eq('ocr multiline', ctx.parseCalendarOcrText('Czwartek 10 września\n18:00\nArek\n11.09 09:00 Trening Ola', '2026-09-09').map(e=>e.name+e.time+'@'+e.iso), ['Arek18:00@2026-09-10','Ola09:00@2026-09-11']);
eq('dedupe', ctx.dedupeSchedCalEvents([
  {date:'2026-09-10', time:'18:00', name:'Arek'},
  {date:'2026-09-10', time:'18:00', name:'arek'}
]).length, 1);
eq('unique people', ctx.uniqueSchedCalPeople([
  {name:'Filip'}, {name:'filip'}, {name:'Adrian'}, {name:'Agata Waniowska'}, {name:'Filip'}
]), ['Filip','Adrian','Agata Waniowska']);
eq('person counts', ctx.schedCalPersonCounts([{name:'Filip'},{name:'filip'},{name:'Adrian'}]).filip, 2);
eq('guest i', ctx.guessSchedGuest('Karolina i Przemek'), true);
eq('guest slash', ctx.guessSchedGuest('Ola/Agata'), true);
eq('guest solo', ctx.guessSchedGuest('Filip'), false);

if (failed) { console.error(failed+' failed'); process.exit(1); }
console.log('\nAll sched calendar-scan tests passed');
