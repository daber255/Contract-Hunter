// Service Worker — zentraler API-Caller (hat host_permissions für api2.warera.io).
// Liest Token aus chrome.storage.local, ruft GET-Endpunkte auf und antwortet auf
// Nachrichten von Popup/Options. Erweiterung ist read-only → keine POST/Calls.

const BASE_URL = "https://api2.warera.io/trpc";

// Warten, bis ein storage-Get fertig ist (wrap callback API).
function getStored(keys) {
  return new Promise(function (resolve) {
    chrome.storage.local.get(keys, resolve);
  });
}

async function getToken() {
  const stored = await getStored(["apiToken"]);
  return stored.apiToken || "";
}

// Manche Prozeduren (z.B. alliance.getById, battle.getById) erwarten den Parameter
// DIREKT als input und NICHT mit dem {"json":{...}}-Wrapper.
const RAW_INPUT_ENDPOINTS = [
  "alliance.getById",
  "battle.getById"
];

// Baut den tRPC-GET-URL. Standard: input={"json":{...}}. Für RAW_INPUT_ENDPOINTS
// wird der Parameter direkt als input übergeben.
function buildUrl(method, params) {
  const input = RAW_INPUT_ENDPOINTS.indexOf(method) >= 0
    ? (params || {})
    : { json: params || {} };
  return BASE_URL + "/" + method + "?input=" + encodeURIComponent(JSON.stringify(input));
}

async function apiRequest(method, params) {
  const token = await getToken();
  if (!token) {
    throw new Error("NO_TOKEN");
  }

  const url = buildUrl(method, params);
  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        "X-API-Key": token,
        Accept: "application/json"
      }
    });
  } catch (err) {
    throw new Error("NETWORK");
  }

  if (response.status === 401 || response.status === 403) {
    const body = await textSafe(response);
    throw new Error("FORBIDDEN" + (body ? " :: " + body.slice(0, 200) : ""));
  }
  if (!response.ok) {
    throw new Error("HTTP " + response.status);
  }

  const json = await response.json();
  if (json && json.error) {
    throw new Error(json.error.message || "API-Error");
  }
  if (json && json.result && json.result.data !== undefined) {
    return json.result.data;
  }
  throw new Error("UNEXPECTED_RESPONSE");
}

function textSafe(response) {
  return response.text().catch(function () { return ""; });
}

// ---- Badge: Anzahl offener Contracts auf dem Icon ----

const BADGE_ALARM = "auctionBadge";

// Lest das gespeicherte Intervall (Sekunden) und plant/ersetzt den Badge-Alarm.
// Chrome erlaubt Alarm-Minimal-Intervall 30s; kleinere Werte werden hochgeklammert.
async function scheduleBadgeAlarm() {
  const stored = await getStored(["refreshInterval"]);
  const sec = Math.max(30, Math.min(60, Number(stored.refreshInterval) || 20));
  try { chrome.alarms.clear(BADGE_ALARM); } catch (e) {}
  chrome.alarms.create(BADGE_ALARM, { periodInMinutes: sec / 60 });
  updateBadge();
}

// Cache für aufgelöste Battles (Gegner-Landbestimmung).
const battleCache = {};

function resolveBattle(id) {
  if (battleCache[id] !== undefined) return Promise.resolve(battleCache[id]);
  return apiRequest("battle.getById", { battleId: id })
    .then(function (d) {
      battleCache[id] = {
        attackerCountry: d && d.attacker && d.attacker.country,
        defenderCountry: d && d.defender && d.defender.country
      };
      return battleCache[id];
    })
    .catch(function () {
      battleCache[id] = null;
      return null;
    });
}

function getOpponentCountry(auction, battleMap) {
  if (!auction || !auction.battle || !battleMap) return null;
  const battle = battleMap[auction.battle];
  if (!battle) return null;
  if (auction.forCountrySide === "attacker") return battle.defenderCountry || null;
  if (auction.forCountrySide === "defender") return battle.attackerCountry || null;
  return null;
}

async function updateBadge() {
  try {
    const token = await getToken();
    if (!token) return; // kein Token → Badge in Ruhe lassen

    const noHit = (await getStored(["noHitCountries", "noHitEnabled"]));
    const noHitCountries = Array.isArray(noHit.noHitCountries) ? noHit.noHitCountries : [];
    const noHitEnabled = noHit.noHitEnabled !== false; // Standard: an

    const data = await apiRequest("mercenaryContractAuction.getPaginatedAuctions", {
      limit: 50,
      status: "active"
    });
    const items = (data && data.items) || [];
    if (!items.length) {
      await clearBadge();
      return;
    }

    let count = items.length;
    if (noHitEnabled && noHitCountries.length) {
      // Gegner-Land pro Contract auflösen und no-hit-gefilterte ausschließen.
      const battleIds = [];
      items.forEach(function (a) { if (a.battle) battleIds.push(a.battle); });
      const seen = {};
      for (let i = 0; i < battleIds.length; i++) {
        const id = battleIds[i];
        if (id && !seen[id]) seen[id] = true;
      }
      await Promise.all(
        Object.keys(seen).map(function (id) {
          return resolveBattle(id).then(function (b) { battleCache[id] = b; });
        })
      );
      count = 0;
      items.forEach(function (a) {
        const opp = getOpponentCountry(a, battleCache);
        // Unbekannter Gegner bleibt sichtbar (konsistent zum Popup).
        if (opp && noHitCountries.indexOf(opp) !== -1) return;
        count++;
      });
    }

    const text = count > 10 ? "10+" : (count > 0 ? String(count) : "");
    await setBadge(text);
  } catch (err) {
    // Fehler (Netzwerk/API) → Badge ruhig lassen, nichts Falsches anzeigen.
  }
}

function setBadge(text) {
  return new Promise(function (resolve) {
    chrome.action.setBadgeText({ text: text }, function () {
      chrome.action.setBadgeBackgroundColor({ color: "#20c96d" }, resolve);
    });
  });
}

function clearBadge() {
  return setBadge("");
}

// Alarme einrichten + Handler.
chrome.runtime.onInstalled.addListener(function () {
  scheduleBadgeAlarm();
});
chrome.runtime.onStartup.addListener(function () {
  scheduleBadgeAlarm();
});
chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name === BADGE_ALARM) updateBadge();
});

// Nachrichten-Handler.
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.type !== "api") {
    if (msg && msg.type === "updateBadge") { updateBadge(); }
    if (msg && msg.type === "rescheduleBadge") { scheduleBadgeAlarm(); }
    return;
  }

  const { method, params } = msg;
  apiRequest(method, params || {})
    .then(function (data) {
      sendResponse({ ok: true, data: data });
    })
    .catch(function (err) {
      sendResponse({ ok: false, error: err.message || String(err) });
    });

  // sendResponse async → true zurückgeben.
  return true;
});
