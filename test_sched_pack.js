#!/usr/bin/env node
'use strict';
/** Grafik: pakiet z góry ma liczbę treningów i odlicza je w kolejnych tygodniach. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
let failed = 0;
function ok(name, cond, extra) {
  if (!cond) {
    console.error('FAIL ' + name + (extra ? ' — ' + extra : ''));
    failed++;
  } else console.log('OK  ', name);
}
function eq(name, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) { console.error('FAIL '+name+'\n  got '+g+'\n  want '+w); failed++; }
  else console.log('OK  ', name);
}

ok('pack field UI', html.includes('id="sched-pack-n"') && html.includes('Ile treningów w pakiecie') && html.includes('id="sched-packs"'));
ok('pack helpers', html.includes('function assignPackageCoverage') && html.includes('function openPackageFor') && html.includes('function packProgress') && html.includes('function packSizeOf'));
ok('requires pack size', html.includes('Podaj za ile treningów jest ta wpłata z góry'));
ok('slot flag counts', html.includes('ostatni') && html.includes('zostało') && html.includes('function schedSlotFlag'));
ok('copy then assign', html.includes('cloneScheduleTx') && /cloneScheduleTx[\s\S]{0,400}openPackageFor/.test(html));

const start = html.indexOf('function toISODate');
const end = html.indexOf('function formatDayLabel');
ok('helpers slice', start>0 && end>start);
const ctx = {
  data: [],
  curMonth: 'Wrzesień 2026',
  MONTHS_PL: ['Styczeń','Luty','Marzec','Kwiecień','Maj','Czerwiec','Lipiec','Sierpień','Wrzesień','Październik','Listopad','Grudzień'],
  save: function(){},
  Date, String, Math, parseInt, parseFloat, isNaN, Set
};
vm.createContext(ctx);
vm.runInContext(html.slice(start, end), ctx);

function tx(id, iso, time, extra) {
  return Object.assign({
    id,
    cat: 'Plan treningowy',
    name: 'Plan treningowy — Arek',
    iso,
    time,
    date: iso.slice(8,10)+'.'+iso.slice(5,7),
    month: iso.slice(5,7)==='08' ? 'Sierpień 2026' : 'Wrzesień 2026',
    amt: 120,
    src: 'cash'
  }, extra||{});
}

ctx.data = [
  tx(1, '2026-08-31', '16:00', {monthPay: true, amt: 800, packN: 4, month: 'Sierpień 2026'}),
  tx(2, '2026-09-02', '16:00'),
  tx(3, '2026-09-07', '16:00'),
  tx(4, '2026-09-09', '16:00'),
  tx(5, '2026-09-14', '16:00'),
  tx(6, '2026-09-16', '16:00')
];
ctx.assignPackageCoverage();
eq('pay stays pay', {pay: ctx.isMonthPay(ctx.data[0]), covered: ctx.isMonthCovered(ctx.data[0])}, {pay: true, covered: false});
eq('first 3 after pay covered', ctx.data.slice(1,4).map(t=>!!(t.monthCovered && t.packOf===1)), [true, true, true]);
eq('training 5 and 6 not in pack of 4', ctx.data.slice(4).map(t=>!(!t.monthCovered && !t.packOf)), [false, false]);
eq('used 4 / remaining 0', {used: ctx.packUsedCount(ctx.data[0]), open: ctx.openPackageFor('Arek','2026-09-14','16:00')}, {used: 4, open: null});

const p2 = ctx.packProgress(ctx.data[1]);
eq('progress on 2nd session', {used: p2.used, n: p2.n, left: p2.left}, {used: 2, n: 4, left: 2});
const p4 = ctx.packProgress(ctx.data[3]);
ok('last of pack', p4 && p4.last && p4.used===4 && p4.left===0, JSON.stringify(p4));

ok('5th needs new payment', !ctx.isMonthCovered(ctx.data[4]) && !ctx.isMonthPay(ctx.data[4]));

ctx.data = [
  tx(10, '2026-09-01', '10:00', {monthPay: true, amt: 600, month: 'Wrzesień 2026'}),
  tx(11, '2026-09-08', '10:00', {month: 'Wrzesień 2026'}),
  tx(12, '2026-09-15', '10:00', {month: 'Wrzesień 2026'}),
  tx(13, '2026-10-06', '10:00', {month: 'Październik 2026'})
];
ctx.assignPackageCoverage();
eq('legacy month covers same month only', {a:!!ctx.data[1].monthCovered, b:!!ctx.data[2].monthCovered, c:!!ctx.data[3].monthCovered}, {a:true, b:true, c:false});

ctx.data = [
  tx(1, '2026-08-31', '16:00', {monthPay: true, amt: 800, packN: 3, month: 'Sierpień 2026'}),
  tx(2, '2026-09-02', '16:00'),
  tx(3, '2026-09-07', '16:00'),
  tx(4, '2026-09-09', '16:00'),
  tx(5, '2026-09-14', '16:00')
];
ctx.assignPackageCoverage();
eq('pay packN stays 3 with extra siblings', ctx.data[0].packN, 3);
eq('only 2 siblings covered for pack of 3', ctx.data.filter(t=>t.packOf===1).length, 2);
ok('4th sibling not covered', !ctx.data[3].monthCovered && !ctx.data[3].packOf);

ok('suggested default 8', ctx.suggestedPackN('Nikt', '2026-09-01')===8);
ctx.data = [tx(20,'2026-09-01','12:00',{monthPay:true,amt:400,packN:12})];
eq('last pack size', ctx.lastPackSizeFor('Arek'), 12);

if (failed) { console.error('\n'+failed+' failed'); process.exit(1); }
console.log('\nAll sched-pack tests passed');
