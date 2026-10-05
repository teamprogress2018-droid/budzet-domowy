# Integracja głosowa (ChatGPT) — fundament

Status: **etap 1 (fundament)**. Ten PR nie łączy jeszcze ChatGPT z aplikacją,
nie dodaje backendu, nie zmienia synchronizacji ani reguł Firestore.

## 1. Jak dziś płyną transakcje (analiza `main`)

Magazyn: `localStorage.budzet_v3` — tablica rekordów
`{id?, date:'DD.MM', iso?:'YYYY-MM-DD', name, cat, amt, month:'Październik 2026', src:'cash'|'bank'|'split', ...}`.
Wydatek ma ujemne `amt`. Stare rekordy (SEED, import wyciągu) nie mają `id` ani `iso`.

| Operacja | Funkcja (`index.html`) | Uwagi |
|---|---|---|
| Dodanie ręczne / edycja | `doQuickAdd()` | `id: Date.now()`, brak kontroli duplikatów |
| Paragon | `confirmReceipt()` | duplikat po `miesiąc\|data\|nazwa\|kwota` |
| Import wyciągu | `doImport()` | ten sam klucz duplikatu, wsadowo |
| Spłata długu | `saveDebtPayment()` | `debtId`, cofanie przez `reverseIfDebtPayment` |
| Cykliczne | `applyRecurringExpenses()` | `id: 'rec-<sub>-<yyyy>-<mm>'`, idempotentne |
| Grafik / treningi | `addScheduleEntry`, `insertSchedulePlan`, `dropScheduleOnCell`, `copyWeekTrainings`, `applySeptemberGrafikRecovery` | przychody `Plan treningowy` |
| Usunięcie | `delTx(idx)`, `deleteScheduleTx`, `deleteMonth`, `clearMonth` | po indeksie tablicy |
| Kopia plikowa | `collectBudgetBackup` / `applyBudgetBackupPayload` | JSON |

Każda ścieżka kończy się `save()` → `localStorage.budzet_v3` → `fbPushBudget()` (debounce 600 ms)
→ `holdings/{uid}` z polami `budgetJson` (cała tablica jako tekst), `budgetTxCount`, `budgetExtras`.

Przy logowaniu `fbApplyCloudBudget()` nadpisuje lokalny budżet chmurą **tylko** gdy lokalny jest
demo albo ma mniej transakcji niż chmura, po czym przeładowuje stronę. Potem `fbPushBudget()`
wysyła lokalną wersję. To model „ostatni zapis wygrywa” na jednym dużym dokumencie.

**Wniosek:** zewnętrzny zapis nie może dopisywać do `holdings.budgetJson`. Jeśli telefon ma
lokalnie ≥ tylu transakcji co chmura, jego `fbPushBudget()` nadpisze wpis głosowy; jeśli mniej —
`fbApplyCloudBudget()` nadpisze lokalne, jeszcze niewysłane zmiany. Potrzebna osobna skrzynka.

## 2. Docelowa architektura

```
ChatGPT (GPT Action / connector, OAuth)
   │  POST /voice/expense   Authorization: Bearer <token użytkownika>
   ▼
Cloud Function (Firebase, Admin SDK)
   1. weryfikuje token → uid (scope tylko: budget.expense.write)
   2. TxCore.normalizeExpense(payload)        ← ten sam tx-core.js
   3. docId = sha256(uid + ':' + externalId)
   4. users/{uid}/voiceInbox/{docId}.create({...})   ← create() = idempotencja po stronie serwera
   5. odpowiedź: added | duplicate | invalid (+ lista błędów do dopytania)
   ▼
Aplikacja (po zalogowaniu, fb-sync.js — kolejny PR)
   1. czyta voiceInbox where status=='pending'
   2. TxCore.applyExpense(data, tx)  → duplikat po externalId = tylko oznacz
   3. save()  (istniejąca ścieżka → localStorage + holdings)
   4. update status:'applied'
```

Idempotencja ma dwie warstwy: `create()` na stałym `docId` w Firestore (ponowiona komenda nie
tworzy drugiego dokumentu) oraz `id: 'ext-<externalId>'` + `externalId` w `budzet_v3`
(przerwanie między `save()` a oznaczeniem nie da duplikatu przy następnym otwarciu).

Proponowane reguły dla nowej kolekcji (do dopisania, bez zmian w istniejących):

```
match /users/{uid}/voiceInbox/{id} {
  allow read: if request.auth != null && request.auth.uid == uid;
  allow create, delete: if false;                       // tylko backend (Admin SDK)
  allow update: if request.auth != null && request.auth.uid == uid
    && resource.data.status == 'pending'
    && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['status','appliedAt'])
    && request.resource.data.status == 'applied';
}
```

## 3. Model danych komendy głosowej

```json
{
  "amount": 126.50,
  "merchant": "Biedronka",
  "category": "Spożywcze",
  "date": "2026-10-04",
  "paymentSource": "karta",
  "note": "",
  "externalId": "chatgpt-7f3c2a91-0001"
}
```

| Pole | Typ | Wymagane | Reguły |
|---|---|---|---|
| `amount` | number lub string | tak | `126.5`, `"126,50"`, `"126,50 zł"`; ≠ 0; ≤ 99 999 999,99; max grosze; zapis zawsze ujemny |
| `merchant` (alias `name`) | string | tak | 1–80 znaków, znaki sterujące usuwane |
| `category` | string | tak | jedna z `EXP_CATS` (wielkość liter i polskie znaki bez znaczenia); nieznana → błąd |
| `date` | string | nie (domyślnie dziś) | `YYYY-MM-DD`, `DD.MM.YYYY`, `dzisiaj`, `wczoraj`, `przedwczoraj`; strefa Europe/Warsaw; nie z przyszłości; max 366 dni wstecz |
| `paymentSource` | string | tak | `cash`/`gotówka` → `cash`; `bank`/`karta`/`przelew`/`blik` → `bank`; `split` niedozwolony |
| `note` | string | nie | max 200 znaków |
| `externalId` | string | tak | `[A-Za-z0-9._:-]{8,128}`, unikalny na jedną komendę, **stały przy ponowieniu** |
| `type` | string | nie | tylko `expense` |

Wynik w `budzet_v3`:

```json
{"id":"ext-chatgpt-7f3c2a91-0001","date":"04.10","iso":"2026-10-04","name":"Biedronka",
 "cat":"Spożywcze","amt":-126.5,"month":"Październik 2026","src":"bank",
 "externalId":"chatgpt-7f3c2a91-0001"}
```

Inne pola z wejścia (`planned`, `debtId`, `recurringId`, `id`, `amt`…) są ignorowane.

## 4. Zagrożenia

- **Anonimowy zapis** — endpoint musi wymagać OAuth; bez tego każdy z linkiem dopisze wydatki.
- **Prompt injection w ChatGPT** — treść ze strony/maila może nakłonić asystenta do wywołania akcji;
  akcja oznaczona jako wymagająca potwierdzenia, scope tylko „dodaj wydatek” (bez odczytu i usuwania).
- **Wyciek tokenu** — krótkie tokeny, możliwość odwołania, limit np. 30 zapisów/h na użytkownika.
- **Reguły Firestore nie są w repo** — nie da się ich przejrzeć w PR; warto dodać `firestore.rules` do repo.
- **Klucz `apiKey` w `fb-sync.js`** — to publiczny identyfikator projektu Firebase, nie sekret;
  bezpieczeństwo zależy od reguł i Auth. Żadnych kluczy Admin SDK we froncie.
- **Konflikty `budgetJson`** — opisane w pkt 1; rozwiązane przez osobną skrzynkę.
- **Fałszywy duplikat** — dwa identyczne zakupy tego samego dnia są blokowane odciskiem;
  asystent musi dopytać i wysłać `allowFingerprintDuplicate` dopiero po potwierdzeniu.
- **Prywatność** — kwoty i sklepy trafiają do historii rozmowy ChatGPT.

## 5. Czego brakuje, żeby ChatGPT zapisywał wydatki

1. Cloud Function `voiceAddExpense` (Firebase Functions, plan Blaze) używająca `tx-core.js`.
2. OAuth / account linking między ChatGPT a kontem Firebase (autoryzacja + token endpoint).
3. Reguły dla `users/{uid}/voiceInbox` (pkt 2) i test w emulatorze.
4. Odbiór skrzynki w `fb-sync.js` po zalogowaniu + oznaczanie `applied`.
5. Schemat OpenAPI akcji dla GPT z potwierdzeniem przed zapisem.
6. (Opcjonalnie) przepięcie `doQuickAdd` / `confirmReceipt` na `TxCore`, z osobnymi testami.
