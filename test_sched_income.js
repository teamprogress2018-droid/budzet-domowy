#!/usr/bin/env node
/** Przychód dnia/tygodnia + treningi gotówka/przelew. */
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

ok('grafik przychód dnia/tygodnia', html.includes('Przychód dnia') && html.includes('Przychód tygodnia') && html.includes('id="sched-sum-day"'));
ok('przychody treningi split', html.includes('id="inc-train-cash"') && html.includes('id="inc-train-bank"') && html.includes('Treningi gotówka') && html.includes('Treningi przelew'));
ok('prepaid month on grid', html.includes('📅 z góry za miesiąc') && html.includes('Klient zapłacił z góry za miesiąc'));
ok('cash+bank helpers', html.includes('function cashIncomeOf') && html.includes('function bankIncomeOf') && html.includes('function sumTrainingCashBank'));

const start = html.indexOf('function cashIncomeOf');
const end = html.indexOf('function getHoldings');
ok('income helpers slice', start>0 && end>start);
const ctx = { console };
vm.createContext(ctx);
vm.runInContext(html.slice(start, end), ctx);

eq('cash solo', ctx.cashIncomeOf({amt:120, src:'cash'}), 120);
eq('bank solo', ctx.bankIncomeOf({amt:120, src:'bank'}), 120);
eq('cash not bank', ctx.bankIncomeOf({amt:120, src:'cash'}), 0);
eq('bank not cash', ctx.cashIncomeOf({amt:120, src:'bank'}), 0);
eq('split cash', ctx.cashIncomeOf({amt:200, src:'split', cashAmt:80, bankAmt:120}), 80);
eq('split bank', ctx.bankIncomeOf({amt:200, src:'split', cashAmt:80, bankAmt:120}), 120);
eq('planned skipped', ctx.cashIncomeOf({amt:120, src:'cash', planned:true}), 0);
eq('month covered skipped', ctx.bankIncomeOf({amt:120, src:'bank', monthCovered:true}), 0);

if (failed) { console.error(failed+' failed'); process.exit(1); }
console.log('\nAll sched income-summary tests passed');
