// Wiederverwendbare API-Helfer für Popup und Options.
// Alle Netzwerk-Calls laufen im background.js Service Worker (hat host_permissions).
// Dieses Modul wrappt die Kommunikation über chrome.runtime.sendMessage.

(function (global) {
  "use strict";

  // Wrapper für einen Aufruf an den Service Worker.
  // Gibt das aufgelöste `result.data` zurück oder wirft einen Fehler.
  function call(method, params, extra) {
    return new Promise(function (resolve, reject) {
      try {
        chrome.runtime.sendMessage({ type: "api", method: method, params: params || {}, extra: extra || {} }, function (res) {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!res) {
            reject(new Error("Keine Antwort vom Service Worker."));
            return;
          }
          if (res.ok) {
            resolve(res.data);
          } else {
            reject(new Error(res.error || "API-Fehler"));
          }
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  // ---- Endpunkte ----

  // Aktive/paginierte Contract-Auktionen.
  // { limit, cursor, countryId, battleId, status }
  function getAuctions(params) {
    return call("mercenaryContractAuction.getPaginatedAuctions", params || {});
  }

  // Alle Länder (Array).
  function getAllCountries() {
    return call("country.getAllCountries", {});
  }

  // Battles (items + nextCursor) — { isActive, limit, cursor, countryId }
  function getBattles(params) {
    return call("battle.getBattles", params || {});
  }

  // Eine Allianz per ID (rawInput — ohne json-Wrapper). Liefert
  // { _id, name, memberCountries: [{country, ...}] }.
  function getAllianceById(allianceId) {
    return call("alliance.getById", { allianceId: allianceId });
  }

  // ---- No-Hit-Liste (chrome.storage.local) ----
  function loadNoHit() {
    return new Promise(function (resolve) {
      chrome.storage.local.get({ noHitCountries: [] }, function (res) {
        resolve(Array.isArray(res.noHitCountries) ? res.noHitCountries : []);
      });
    });
  }

  function saveNoHit(list) {
    return new Promise(function (resolve) {
      chrome.storage.local.set({ noHitCountries: list }, resolve);
    });
  }

  // ---- Battle-Map: battleId -> { attackerCountry, defenderCountry } ----
  var battleCache = {};

  // Löst gezielt nur die übergebenen battleIds auf (via battle.getById, rawInput).
  // Deutlich effizienter als alle Battles zu scannen. Gibt Map<battleId, {...}> zurück.
  function resolveBattleMap(battleIds) {
    var ids = [];
    var seen = {};
    (Array.isArray(battleIds) ? battleIds : []).forEach(function (b) {
      if (b && !seen[b]) { seen[b] = true; ids.push(b); }
    });

    function resolve(rest) {
      var id = rest[0];
      var tail = rest.slice(1);
      return WEcallBattle(id).then(function () {
        if (tail.length) return resolve(tail);
        return battleCache;
      });
    }

    return resolve(ids);
  }

  function WEcallBattle(id) {
    if (battleCache[id]) return Promise.resolve(battleCache[id]);
    return call("battle.getById", { battleId: id }).then(function (d) {
      battleCache[id] = {
        attackerCountry: d && d.attacker && d.attacker.country,
        defenderCountry: d && d.defender && d.defender.country
      };
      return battleCache[id];
    }).catch(function () {
      battleCache[id] = null;
      return null;
    });
  }

  // Bestimmt das Gegner-Land einer Auktion anhand der Battle-Seiten.
  // Gibt die Country-ID zurück oder null, wenn nicht auflösbar.
  function getOpponentCountry(auction, battleMap) {
    if (!auction || !auction.battle || !battleMap) return null;
    var battle = battleMap[auction.battle];
    if (!battle) return null;
    var side = auction.forCountrySide;
    if (side === "attacker") return battle.defenderCountry || null;
    if (side === "defender") return battle.attackerCountry || null;
    return null;
  }

  // ---- Allianz-Map: allianceId -> { name, countryIds: [] } ----
  var allianceCache = null;

  // Baut die Allianzen aus country.allianceId + lädt Namen best-effort via
  // alliance.getById. Verwendet einen kleinen Delay, um Cloudflare-Rate-Limit zu vermeiden.
  function getAllianceMap(_a) {
    var _b;
    var opts = _a || {};
    if (allianceCache) return Promise.resolve(allianceCache);
    var delay = opts.delay || 260;
    return countryMap().then(function () {
      var ids = [];
      var seen = {};
      allCountries.forEach(function (c) {
        if (c && c.allianceId && !seen[c.allianceId]) {
          seen[c.allianceId] = true;
          ids.push(c.allianceId);
        }
      });
      var map = {};
      function next(i) {
        if (i >= ids.length) {
          allianceCache = map;
          return map;
        }
        var aid = ids[i];
        map[aid] = { name: null, countryIds: membersOf(aid) };
        // Name best-effort laden
        return getAllianceById(aid).then(function (a) {
          if (a && a.name) map[aid].name = a.name;
          return waitTicks(delay).then(function () { return next(i + 1); });
        }).catch(function () {
          return waitTicks(delay).then(function () { return next(i + 1); });
        });
      }
      return next(0);
    });
  }

  function membersOf(allianceId) {
    var out = [];
    allCountries.forEach(function (c) {
      if (c && c.allianceId === allianceId) out.push(c._id);
    });
    return out;
  }

  function waitTicks(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  // ---- Caching (im Popup-Kontext, pro Popup-Öffnung) ----
  var countriesCache = null;
  var allCountries = [];

  // Länder als Map von _id -> country (mit Cache).
  function countryMap() {
    return getAllCountries().then(function (list) {
      countriesCache = countriesCache || {};
      (Array.isArray(list) ? list : []).forEach(function (c) {
        if (c && c._id) countriesCache[c._id] = c;
      });
      allCountries.length = 0;
      (Array.isArray(list) ? list : []).forEach(function (c) { allCountries.push(c); });
      return countriesCache;
    });
  }

  function countryName(id) {
    if (!id || !countriesCache || !countriesCache[id]) return id;
    return countriesCache[id].name || countriesCache[id].code || id;
  }

  function countryCode(id) {
    if (!id || !countriesCache || !countriesCache[id]) return "";
    return countriesCache[id].code || "";
  }

  // Alle Seiten einer paginierten Auctions-Liste einsammeln (bis maxPages).
  function collectAllAuctions(_a) {
    var _b;
    var opts = _a || {};
    var limit = opts.limit || 50;
    var status = opts.status || "active";
    var countryId = opts.countryId;
    var maxPages = opts.maxPages || 20;
    var all = [];
    function page(cursor) {
      return getAuctions({ limit: limit, status: status, countryId: countryId, cursor: cursor }).then(function (data) {
        var items = (data && data.items) || [];
        all = all.concat(items);
        if (data && data.nextCursor && all.length % 50 === 0 && page.__count < maxPages) {
          page.__count = (page.__count || 0) + 1;
          return page(data.nextCursor);
        }
        return all;
      });
    }
    page.__count = 0;
    return page(undefined);
  }

  global.WE = {
    call: call,
    getAuctions: getAuctions,
    getAllCountries: getAllCountries,
    getBattles: getBattles,
    getAllianceById: getAllianceById,
    countryMap: countryMap,
    countryName: countryName,
    countryCode: countryCode,
    collectAllAuctions: collectAllAuctions,
    loadNoHit: loadNoHit,
    saveNoHit: saveNoHit,
    resolveBattleMap: resolveBattleMap,
    getOpponentCountry: getOpponentCountry,
    getAllianceMap: getAllianceMap,
    countries: allCountries
  };
})(typeof window !== "undefined" ? window : globalThis);
