# AGENTS.md

## Projekt
**WarEra Contract Hunter** — Eine Chrome/Chromium-Erweiterung (Manifest V3, Vanilla JS, kein Build-Tool) für das Browserspiel [WarEra](https://warera.io). Sie zeigt aktive **Söldner-Contract-Auktionen** aus der WarEra-API an, filtert/sortiert sie nach Lohnenswertigkeit und verlinkt zum Spiel, wo man eingeloggt bieten kann.

Das Bieten (`mercenaryContractAuction.placeBid`) ist eine POST-Mutation und mit dem reinen **API-Token blockiert** (HTTP 403 `FORBIDDEN` — "API tokens cannot access this endpoint"). Daher: Die Erweiterung ist **read-only** und verlinkt zum Spiel (Beat-Seite) zum Bieten. Keine POST/Bid-Calls einbauen.

## Struktur
```
manifest.json      MV3-Manifest
background.js      Service Worker — zentraler API-Caller mit Token, Caching, Fehlerhandling
api.js             Wiederverwendbare API-Helfer (im Popup-Kontext genutzt)
options.html/js    Options-Seite: API-Token eingeben/speichern
popup.html/css/js  Popup: Contract-Liste mit Filter/Sortierung
icons/             Erweiterungs-Icons (16/48/128)
```

## API-Grundlagen (live verifiziert)
- **Basis-URL:** `https://api2.warera.io/trpc`
- **Auth-Header:** `X-API-Key: <token>` (Token aus `chrome.storage.local`, Key `apiToken`)
- **Alle Lese-Endpunkte sind GET**, trotz openapi.json (das POST angibt). Parameter als URL `?input={"json":{<params>}}` (URL-encoded).
- **Antwort-Wrapper:** `{ "result": { "data": ... } }` → `result.data`
- **Pagination:** `result.data.items` + `result.data.nextCursor` (bei paginierten Endpunkten)
- **RawInput-Endpunkte:** Manche `getById`-Prozeduren erwarten den Parameter DIREKT als `input` und NICHT mit `{"json":{...}}`-Wrapper: `alliance.getById`, `battle.getById` → `?input={"allianceId":"..."}` bzw. `?input={"battleId":"..."}`. In `background.js` über die Liste `RAW_INPUT_ENDPOINTS` geregelt.

### Relevante Endpunkte (GET, lesend — funktionieren mit Token)
- `mercenaryContractAuction.getPaginatedAuctions`
  - Params: `limit` (1–50), `cursor`, `countryId`, `battleId`, `status` (`active`|`won`|...)
  - Auction-Felder: `_id, country, createdBy, battle, forCountry, forCountrySide` (`attacker`/`defender`), `minimumDamage, budget, initialPerK, duration, professionalsOnly, expiresAt, currentPerK, currentPayout, bids[{mu,user,perK,payout,bidAt}], status, currentWinner`
- `country.getAllCountries` → Array aller Länder (Felder: `_id, name, code, allianceId, ...`)
- `battle.getBattles` → `items` (attacker/defender mit `region`, `country`) zur Auflösung von Region/Land
- `battle.getById` → einzelner Battle (rawInput, `?input={"battleId":"..."}`), liefert `attacker.country`/`defender.country`. Wird gezielt pro Auktions-Battle geladen (`api.resolveBattleMap`), nicht als Vollscan.
- `alliance.getById` → einzelne Allianz (rawInput, `?input={"allianceId":"..."}`), liefert `name` + `memberCountries[]`. Für die No-Hit-Allianz-Auswahl; Namen best-effort mit Delay wegen Cloudflare-Rate-Limit (Fehler `1010`).
- Weitere lesende Endpunkte: `company.*`, `country.*`, `region.*`, `battle.*`, `round.*`, `mu.*`, `user.*` (siehe Community-Doku)

## Features
- **Popup (Contract-Liste):** zeigt aktive Auctions (Budget, min. Schaden, PerK, Auszahlung, Bid-Anzahl, ProfessionalsOnly, Live-Countdown), filtert nach Land/Seite/Pro, sortiert, verlinkt zur Battle-Seite zum Bieten.
- **No-Hit-Liste:** Länder, deren Contracts (Gegner-Land der Battle-Seite) ausgeblendet werden sollen.
  - Verwaltet auf der Options-Seite (einzelne Länder via Such-Dropdown + Chips, oder ganze Allianzen anklicken → alle Mitgliedsländer).
  - Gegner-Land-Auflösung: `auction.battle` → `battle.getById` → bei `forCountrySide=attacker` ist Gegner `defender.country`, umgekehrt sonst.
  - **Unbekannter Gegner** (Battle nicht auflösbar) → Contract bleibt sichtbar (kein irrtümliches Ausblenden).
   - Im Popup umschaltbar (Checkbox `No-Hit-Filter`, Standard an). Gespeichert in `chrome.storage.local` (Key `noHitCountries`, Array von Country-IDs; Toggle-Status Key `noHitEnabled`, Standard `true`).
- **Toolbar-Badge (Icon-Zähler):** zeigt die Anzahl aktuell biegbarer (aktiver) Contracts direkt auf dem Extension-Icon, ohne das Popup zu öffnen. Läuft im Service Worker `background.js` via `chrome.alarms` (`auctionBadge`, Permission `alarms`). Zählung (erste Seite, limit 50): 0 → kein Badge, 1–10 → exakte Zahl, 11+ → `10+`. Bei aktivem No-Hit-Filter (`noHitEnabled`) wird nur die no-hit-gefilterte (biegbare) Anzahl gezählt; Gegner-Land-Auflösung pro Contract via `battle.getById`. Badge wird auch bei Popup-Toggle-Wechsel sofort aktualisiert (`updateBadge`-Message).
- **Auto-Update-Intervall:** in den Einstellungen wählbar (5s–60s, Key `refreshInterval`, Standard 20s). Steuert das Auto-Refresh der Contract-Liste im Popup (`popup.js`, `REFRESH_MS`) und das Badge-Intervall (`background.js`, `scheduleBadgeAlarm` — Chrome-Alarm-Minimum 30s wird hochgeklammert). Änderung wird via `rescheduleBadge`-Message an den SW gemeldet.
- **Allianz→Länder:** `country.allianceId` (aus `getAllCountries`) gruppiert Länder; Namen via `alliance.getById`.

### Bid-Methoden
- `mercenaryContractAuction.placeBid` = **POST-Mutation, mit API-Token 403** → NICHT verwenden.

### Doku-Links (Community)
- https://github.com/zertw1/warera-bot/blob/main/API_documentation.md
- https://api2.warera.io/openapi.json
- https://api2.warera.io/docs/

## In-Game-Link (Bieten)
Contracts werden im Spiel auf der **Battle-Seite** angezeigt und dort bebietet.
- Link-Ziel pro Auktion: `https://app.warera.io/battle/<battleId>` (aus `auction.battle`)

## Testen
- **Chrome/Chromium unpacked laden:** `chrome://extensions` → Developer Mode → "Unpacked" → Projektordner wählen.
- **Waterfox/Firefox (MV3) laden:** Manifest wechseln + temporär laden:
  1. `manifest.firefox.json` nach `manifest.json` kopieren: `cp manifest.firefox.json manifest.json`
  2. `about:debugging#/runtime/this-firefox` öffnen → "Temporäre Erweiterung laden" → `manifest.json` wählen.
  3. Nach dem Test zurückwechseln: `git checkout manifest.json` bzw. das Chrome-Manifest wiederherstellen (für Chrome muss `background.scripts` → `service_worker` sein).
- **Token eingeben:** Options-Seite der Extension öffnen → Token speichern.
- **API-Referenz-Calls (curl, mit Test-Token):**
  ```bash
  TOKEN="wae_a93ae9acb42213289c8b3e4fb7edb4ffa00528732034cc494cf983d073624af1"
  curl -s "https://api2.warera.io/trpc/mercenaryContractAuction.getPaginatedAuctions?input=%7B%22json%22%3A%7B%22limit%22%3A10%2C%22status%22%3A%22active%22%7D%7D" -H "X-API-Key: $TOKEN"
  curl -s "https://api2.warera.io/trpc/country.getAllCountries" -H "X-API-Key: $TOKEN"
  ```
- **Bid-Test (erwartet 403):** `curl -s -X POST "https://api2.warera.io/trpc/mercenaryContractAuction.placeBid" -H "X-API-Key: $TOKEN" -H "Content-Type: application/json" -d '{}'`

## Hinweise
- Kein Build-Tool, kein Framework. Reines HTML/CSS/JS.
- Token nur lokal in `chrome.storage.local` speichern (Options-Seite), nie loggen.
- Erweiterung ist read-only; keine Schreibzugriffe auf die API.
