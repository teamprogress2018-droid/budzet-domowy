#!/usr/bin/env node
'use strict';
/** Login: apka ładuje Firebase auth, nie bypass. */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const sync = fs.readFileSync(path.join(__dirname, 'fb-sync.js'), 'utf8');
let failed = 0;
function ok(name, cond) {
  if (!cond) { console.error('FAIL', name); failed++; }
  else console.log('OK  ', name);
}

ok('loads fb-sync.js', /<script src="fb-sync\.js"><\/script>/.test(html));
ok('no bypass script', !html.includes('fb-sync-bypass'));
ok('login overlay', html.includes('id="login-overlay"') && html.includes('fbDoLogin()'));
ok('sign in exists', sync.includes('signInWithEmailAndPassword') && sync.includes('function fbDoLogin'));
ok('auth state shows app', sync.includes("overlay.style.display = 'none'") && sync.includes("app.style.display = 'flex'"));

if (failed) process.exit(1);
console.log('\nAll login fb-sync tests passed');
