// ═══════════════════════════════════════════════════════════
// VOICE-PARSE — zamiana zdania (dyktowanego lub wpisanego) na pola wydatku
// ═══════════════════════════════════════════════════════════
// "126,50 zł Biedronka spożywcze karta dzisiaj"
//   → { amount: 126.5, merchant: 'Biedronka', category: 'Spożywcze',
//       paymentSource: 'bank', date: '2026-10-04', ... }
//
// Czysta funkcja: bez DOM, bez zapisu. Wynik ma kształt wejścia
// TxCore.normalizeExpense, a o zapisie zawsze decyduje użytkownik
// (formularz „Szybkie dodanie” → „Dodaj transakcję”).
(function(root, factory){
  const core = (typeof module === 'object' && module.exports) ? require('./tx-core.js') : root.TxCore;
  const api = factory(core);
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.VoiceParse = api;
})(typeof self !== 'undefined' ? self : this, function(TxCore){
  'use strict';

  const MONTHS_GEN = ['stycznia','lutego','marca','kwietnia','maja','czerwca','lipca','sierpnia','wrzesnia','pazdziernika','listopada','grudnia'];

  // Słowa wypowiadane zamiast nazwy kategorii (po złożeniu polskich znaków).
  const CATEGORY_ALIASES = {
    'Spożywcze': ['spozywcze','spozywka','zakupy spozywcze','spozywczy','spozywcza','artykuly spozywcze'],
    'Paliwo': ['paliwo','tankowanie','benzyna','diesel'],
    'Jedzenie poza domem': ['jedzenie poza domem','jedzenie na miescie','restauracja','na miescie'],
    'Zakupy online': ['zakupy online','online','internet zakupy'],
    'Sport i hobby': ['sport i hobby','sport','hobby'],
    'Edukacja': ['edukacja','szkolenie','kurs'],
    'Dom i mieszkanie': ['dom i mieszkanie','dom','mieszkanie'],
    'Zdrowie': ['zdrowie','leki','lekarstwa'],
    'Subskrypcje': ['subskrypcje','subskrypcja','abonament'],
    'Kosmetyki': ['kosmetyki','kosmetyk'],
    'Telefon/TV/internet': ['telefon tv internet','internet','telewizja'],
    'Opłaty bankowe': ['oplaty bankowe','oplata bankowa','prowizja'],
    'Transport/parking': ['transport parking','transport','parking','komunikacja'],
    'Telefon dziecka': ['telefon dziecka'],
    'Spłata długu': ['splata dlugu','splata'],
    'Prezenty/różne': ['prezenty rozne','prezenty','prezent'],
    'Prowadzenie firmy': ['prowadzenie firmy','firma'],
    'Koszty firmowe': ['koszty firmowe','koszt firmowy'],
    'Inne': ['inne','rozne']
  };

  const SOURCE_WORDS = {
    cash: ['gotowka','gotowke','gotowki','gotowkowo','cash'],
    bank: ['karta','karte','karty','karcie','kartowo','blik','blikiem','przelew','przelewem','bank','card']
  };

  const FILLER = new Set([
    'dodaj','dopisz','wpisz','zapisz','wydatek','wydatki','wydalem','wydalam','wydane','zaplacilem','zaplacilam',
    'zaplacone','zaplacony','kupilem','kupilam','paragon','paragonu','za','w','we','na','z','ze','do','i','oraz',
    'kategoria','kategorii','kategorie','platnosc','platnosci','placone','zrodlo','data','dnia','sklep','sklepie',
    'kwota','kwote','zl','zlotych','zlote','zloty','pln','gr','groszy','grosze','grosz','prosze','to','bylo','kiedy',
    'dzisiaj','dzis','wczoraj','przedwczoraj','dzisiejszy','wczorajszy','ok','okej'
  ]);

  const CURRENCY = '(?:zł|zl|złotych|zlotych|złote|zlote|złoty|zloty|pln)';
  const CENTS = '(?:gr|groszy|grosze|grosz)';
  const MONTH_WORDS = '(?:stycz|lut|mar|kwie|maj|czerw|lip|sierp|wrze|paźdz|pazdz|listop|grud)';

  function fold(s){
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(/ł/g, 'l')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }
  function escapeRe(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  // Wycina pierwsze dopasowanie z tekstu; zwraca [match, resztaTekstu].
  function cut(text, re){
    const m = re.exec(text);
    if(!m) return [null, text];
    return [m, (text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim()];
  }

  // Liczebniki słownie → cyfry ("sto dwadzieścia sześć złotych" → "126 złotych").
  const NUM_WORDS = (function(){
    const m = {};
    ['zero','jeden','dwa','trzy','cztery','piec','szesc','siedem','osiem','dziewiec','dziesiec','jedenascie','dwanascie',
     'trzynascie','czternascie','pietnascie','szesnascie','siedemnascie','osiemnascie','dziewietnascie'].forEach((w, i) => { m[w] = i; });
    m.jedna = 1; m.dwie = 2;
    ['dwadziescia','trzydziesci','czterdziesci','piecdziesiat','szescdziesiat','siedemdziesiat','osiemdziesiat','dziewiecdziesiat']
      .forEach((w, i) => { m[w] = (i + 2) * 10; });
    ['sto','dwiescie','trzysta','czterysta','piecset','szescset','siedemset','osiemset','dziewiecset']
      .forEach((w, i) => { m[w] = (i + 1) * 100; });
    return m;
  })();
  const THOUSAND = ['tysiac','tysiace','tysiecy'];
  const MONEY_WORDS = ['zl','zloty','zlote','zlotych','pln','gr','grosz','grosze','groszy'];

  function wordsToNumbers(text){
    const words = text.split(' ');
    const hasDigits = /\d/.test(text);
    const out = [];
    let i = 0;
    while(i < words.length){
      let j = i, total = 0, cur = 0, any = false;
      while(j < words.length){
        const w = fold(words[j]);
        if(Object.prototype.hasOwnProperty.call(NUM_WORDS, w)){ cur += NUM_WORDS[w]; any = true; j++; }
        else if(THOUSAND.includes(w) && (any || j === i)){ total += (cur || 1) * 1000; cur = 0; any = true; j++; }
        else break;
      }
      const next = fold(words[j] || '');
      if(any && (!hasDigits || MONEY_WORDS.includes(next))){
        out.push(String(total + cur));
        i = j;
      } else {
        out.push(words[i]);
        i++;
      }
    }
    return out.join(' ');
  }

  function extractAmount(text){
    let m, rest;
    // "126 zł 50 gr", "126 złotych i 50 groszy"
    [m, rest] = cut(text, new RegExp('(\\d{1,8})\\s*' + CURRENCY + '\\s*(?:i\\s*)?(\\d{1,2})\\s*' + CENTS + '(?![a-ząćęłńóśźż])', 'i'));
    if(m) return { amount: parseInt(m[1], 10) + parseInt(m[2], 10) / 100, rest };
    // "126 zł 50" (bez "gr"), ale nie "126 zł 5 października"
    [m, rest] = cut(text, new RegExp('(\\d{1,8})\\s*' + CURRENCY + '\\s+(\\d{2})(?![\\d.,])(?!\\s*' + MONTH_WORDS + ')', 'i'));
    if(m) return { amount: parseInt(m[1], 10) + parseInt(m[2], 10) / 100, rest };
    // "126,50", "126.50 zł", "126 zł", "126" — pomijając daty "5.10" / "5 października"
    const re = new RegExp('(?<![\\d.,])(\\d{1,8}(?:[.,]\\d{1,2})?)(?![\\d])(?!\\s*' + MONTH_WORDS + ')(?![.,]\\d)\\s*(' + CURRENCY + ')?(?![a-ząćęłńóśźż])', 'gi');
    let best = null, hit;
    while((hit = re.exec(text))){
      const dm = /^(\d{1,2})[.](\d{1,2})$/.exec(hit[1]);
      if(dm && !hit[2] && isDayMonth(+dm[1], +dm[2])) continue;        // "5.10" to data, nie kwota
      if(!best || (hit[2] && !best[2])) best = hit;                     // z walutą ma pierwszeństwo
      if(hit[2]) break;
    }
    if(best){
      rest = (text.slice(0, best.index) + ' ' + text.slice(best.index + best[0].length)).replace(/\s+/g, ' ').trim();
      return { amount: parseFloat(best[1].replace(',', '.')), rest };
    }
    return { amount: null, rest: text };
  }

  function todayParts(now){
    const iso = TxCore.todayISO(now);
    return { iso, y: +iso.slice(0, 4), m: +iso.slice(5, 7), d: +iso.slice(8, 10) };
  }
  function isDayMonth(d, m){ return d >= 1 && d <= 31 && m >= 1 && m <= 12; }
  function pad(n){ return String(n).padStart(2, '0'); }

  // Data bez roku: bierzemy bieżący rok, a gdy wychodzi przyszłość — poprzedni.
  function dayMonthToISO(d, m, y, now){
    const t = todayParts(now);
    let year = y || t.y;
    let iso = year + '-' + pad(m) + '-' + pad(d);
    if(!y && iso > t.iso) iso = (year - 1) + '-' + pad(m) + '-' + pad(d);
    return iso;
  }

  function extractDate(text, now){
    let m, rest;
    [m, rest] = cut(text, /\b(\d{4})-(\d{2})-(\d{2})\b/);
    if(m) return { date: m[0], rest };
    [m, rest] = cut(text, new RegExp('(?<![\\d.,])(\\d{1,2})\\.(\\d{1,2})(?:\\.(\\d{4}))?(?![\\d.,])(?!\\s*' + CURRENCY + ')', 'i'));
    if(m && isDayMonth(+m[1], +m[2])) return { date: dayMonthToISO(+m[1], +m[2], m[3] ? +m[3] : null, now), rest };
    const words = text.split(' ');
    for(let i = 0; i < words.length; i++){
      const w = fold(words[i]);
      if(w === 'dzisiaj' || w === 'dzis' || w === 'wczoraj' || w === 'przedwczoraj'){
        words.splice(i, 1);
        return { date: w === 'dzis' ? 'dzisiaj' : w, rest: words.join(' ') };
      }
      const mi = MONTHS_GEN.indexOf(w);
      if(mi >= 0 && i > 0 && /^\d{1,2}$/.test(words[i - 1])){
        let y = null, n = 2;
        if(/^\d{4}$/.test(words[i + 1] || '')){ y = +words[i + 1]; n = 3; }
        const iso = dayMonthToISO(+words[i - 1], mi + 1, y, now);
        words.splice(i - 1, n);
        return { date: iso, rest: words.join(' ') };
      }
    }
    return { date: null, rest: text };
  }

  function extractSource(text){
    const words = text.split(' ');
    for(let i = 0; i < words.length; i++){
      const w = fold(words[i]);
      const src = SOURCE_WORDS.cash.includes(w) ? 'cash' : SOURCE_WORDS.bank.includes(w) ? 'bank' : null;
      if(src){ words.splice(i, 1); return { paymentSource: src, rest: words.join(' ') }; }
    }
    return { paymentSource: null, rest: text };
  }

  function extractCategory(text, categories){
    const allowed = Array.isArray(categories) && categories.length ? categories : TxCore.EXPENSE_CATEGORIES;
    const pairs = [];
    allowed.forEach(cat => {
      pairs.push([fold(cat), cat]);
      (CATEGORY_ALIASES[cat] || []).forEach(a => pairs.push([a, cat]));
    });
    pairs.sort((a, b) => b[0].length - a[0].length);          // najdłuższe frazy najpierw
    const words = text.split(' ');
    const folded = words.map(fold);
    for(const [phrase, cat] of pairs){
      if(!phrase) continue;
      const pw = phrase.split(' ');
      for(let i = 0; i + pw.length <= folded.length; i++){
        if(pw.every((p, k) => folded[i + k] === p)){
          words.splice(i, pw.length);
          return { category: cat, rest: words.join(' ') };
        }
      }
    }
    return { category: null, rest: text };
  }

  function guessCategory(merchant, merchantKeywords, categories){
    if(!merchant || !merchantKeywords) return null;
    const low = fold(merchant);
    for(const cat of Object.keys(merchantKeywords)){
      if(categories && !categories.includes(cat)) continue;
      if((merchantKeywords[cat] || []).some(k => fold(k) && (' ' + low + ' ').includes(' ' + fold(k) + ' '))) return cat;
    }
    return null;
  }

  function cleanMerchant(text){
    const words = String(text || '')
      .replace(/[,;:!?„”"]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .filter(w => !FILLER.has(fold(w)));
    while(words.length && /^[\d.,-]+$/.test(words[words.length - 1])) words.pop();
    return words.map(w => (/^[a-ząćęłńóśźż]/.test(w) ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ').slice(0, 80);
  }

  // opts: { now, categories, merchantKeywords (np. CAT_KW z index.html) }
  // → { amount, merchant, category, categoryGuessed, paymentSource, date, missing[], transcript }
  function parseVoiceExpense(transcript, opts){
    const o = opts || {};
    let text = String(transcript || '').replace(/\s+/g, ' ').trim();
    const out = { transcript: text, amount: null, merchant: '', category: null, categoryGuessed: false,
      paymentSource: null, date: null, missing: [] };
    if(!text){ out.missing = ['amount','merchant','category','paymentSource']; return out; }

    let r;
    text = wordsToNumbers(text);
    r = extractDate(text, o.now);      out.date = r.date;                   text = r.rest;
    r = extractAmount(text);           out.amount = r.amount;               text = r.rest;
    r = extractSource(text);           out.paymentSource = r.paymentSource; text = r.rest;
    r = extractCategory(text, o.categories); out.category = r.category;     text = r.rest;
    out.merchant = cleanMerchant(text);

    if(!out.category){
      const g = guessCategory(out.merchant, o.merchantKeywords, o.categories || TxCore.EXPENSE_CATEGORIES);
      if(g){ out.category = g; out.categoryGuessed = true; }
    }
    if(out.date == null) out.date = 'dzisiaj';
    if(out.amount == null) out.missing.push('amount');
    if(!out.merchant) out.missing.push('merchant');
    if(!out.category) out.missing.push('category');
    if(!out.paymentSource) out.missing.push('paymentSource');
    return out;
  }

  return { parseVoiceExpense, CATEGORY_ALIASES };
});
