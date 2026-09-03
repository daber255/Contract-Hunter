(function () {
  "use strict";

  var tokenInput = document.getElementById("token");
  var statusEl = document.getElementById("status");
  var saveBtn = document.getElementById("save");
  var testBtn = document.getElementById("test");

  // Update-Intervall
  var intervalSelect = document.getElementById("refreshInterval");
  var saveIntervalBtn = document.getElementById("saveInterval");
  var intervalStatusEl = document.getElementById("intervalStatus");

  // No-Hit
  var countrySearch = document.getElementById("countrySearch");
  var chipsEl = document.getElementById("noHitChips");
  var emptyEl = document.getElementById("noHitEmpty");
  var clearBtn = document.getElementById("clearNoHit");
  var allianceStatus = document.getElementById("allianceStatus");
  var allianceList = document.getElementById("allianceList");

  var allCountries = [];       // { _id, name, code }
  var noHit = [];              // [] of country _id
  var mapIdToCountry = {};

  function setStatus(text, type) {
    statusEl.textContent = text;
    statusEl.className = type || "";
  }

  // ---------- Token ----------
  function loadToken() {
    chrome.storage.local.get({ apiToken: "" }, function (res) {
      if (res.apiToken) tokenInput.value = res.apiToken;
    });
  }

  function save() {
    var token = tokenInput.value.trim();
    chrome.storage.local.set({ apiToken: token }, function () {
      setStatus(token ? "Gespeichert." : "Token entfernt.", "ok");
    });
  }

  function test() {
    var token = tokenInput.value.trim();
    if (!token) { setStatus("Bitte zuerst Token eingeben.", "error"); return; }
    setStatus("Teste ...");
    chrome.storage.local.set({ apiToken: token }, function () {
      WE.call("country.getAllCountries", {})
        .then(function (data) {
          var n = Array.isArray(data) ? data.length : 0;
          setStatus("Token gültig — " + n + " Länder geladen.", "ok");
        })
        .catch(function (err) {
          setStatus("Token ungültig oder gesperrt (" + err.message + ").", "error");
        });
    });
  }

  // ---------- No-Hit: Länder laden ----------
  function loadCountries() {
    return WE.countryMap().then(function () {
      allCountries = WE.countries.slice();
      allCountries.sort(function (a, b) {
        return (a.name || "").localeCompare(b.name || "");
      });
      mapIdToCountry = {};
      allCountries.forEach(function (c) { mapIdToCountry[c._id] = c; });
      populateSearch();
      return allCountries;
    }).catch(function (err) {
      countrySearch.innerHTML = '<option value="">Länder konnten nicht geladen werden</option>';
      allianceStatus.textContent = "Länder konnten nicht geladen werden: " + (err.message || "");
      throw err;
    });
  }

  function populateSearch() {
    countrySearch.innerHTML = "";
    var ph = document.createElement("option");
    ph.value = "";
    ph.textContent = "— Land auswählen … —";
    countrySearch.appendChild(ph);
    allCountries.forEach(function (c) {
      var opt = document.createElement("option");
      opt.value = c._id;
      opt.textContent = c.name + (c.code ? " (" + c.code + ")" : "");
      countrySearch.appendChild(opt);
    });
  }

  // ---------- No-Hit: Darstellung ----------
  function setNames(names) {
    // Namen der No-Hit-IDs anzeigen
    chipsEl.innerHTML = "";
    noHit.forEach(function (id) {
      var c = mapIdToCountry[id];
      var name = c ? c.name : id;
      var chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = name;
      var x = document.createElement("button");
      x.className = "x";
      x.textContent = "×";
      x.title = "Entfernen";
      x.addEventListener("click", function () {
        removeCountry(id);
      });
      chip.appendChild(x);
      chipsEl.appendChild(chip);
    });
    emptyEl.style.display = noHit.length ? "none" : "";
    clearBtn.style.display = noHit.length ? "" : "none";
  }

  function removeCountry(id) {
    noHit = noHit.filter(function (x) { return x !== id; });
    persistNoHit();
    setNames();
  }

  function addCountries(ids) {
    var added = 0;
    (Array.isArray(ids) ? ids : []).forEach(function (id) {
      if (noHit.indexOf(id) === -1) { noHit.push(id); added++; }
    });
    if (added) {
      persistNoHit();
      setNames();
      markAllianceButtons();
    }
    return added;
  }

  function addOneCountry() {
    var id = countrySearch.value;
    if (!id) return;
    if (noHit.indexOf(id) === -1) {
      noHit.push(id);
      persistNoHit();
      setNames();
      markAllianceButtons();
    }
    countrySearch.value = "";
  }

  function persistNoHit() {
    WE.saveNoHit(noHit).catch(function () {});
  }

  // ---------- Allianzen ----------
  function loadAlliances() {
    allianceStatus.textContent = "Lade Allianzen …";
    allianceList.innerHTML = "";
    WE.getAllianceMap({ delay: 260 }).then(function (map) {
      allianceStatus.textContent = "";
      var keys = Object.keys(map);
      if (!keys.length) {
        allianceList.innerHTML = '<div class="empty-note">Keine Allianzen gefunden.</div>';
        return;
      }
      keys.sort(function (a, b) {
        var na = (map[a].name || a).toLowerCase();
        var nb = (map[b].name || b).toLowerCase();
        return na.localeCompare(nb);
      }).forEach(function (aid) {
        var a = map[aid];
        var btn = document.createElement("button");
        btn.className = "alliance-btn";
        btn.setAttribute("data-aid", aid);
        btn.innerHTML = "<div>" + escapeHtml(a.name || aid) + ' <span class="cnt">(' + a.countryIds.length + " Länder)</span></div>";
        btn.addEventListener("click", function () {
          var n = addCountries(a.countryIds);
          allianceStatus.textContent = n > 0
            ? a.name + ": " + n + " Länder zur No-Hit-Liste hinzugefügt."
            : a.name + " ist bereits vollständig auf der No-Hit-Liste.";
        });
        allianceList.appendChild(btn);
      });
      markAllianceButtons();
    }).catch(function (err) {
      allianceStatus.textContent = "Allianzen konnten nicht geladen werden: " + (err.message || err);
    });
  }

  function markAllianceButtons() {
    // Hebt bereits vollständig abgedeckte Allianzen optisch hervor.
    var btns = allianceList.querySelectorAll(".alliance-btn");
    btns.forEach(function (btn) {
      // nicht-produktiv: wir belassen einfache Darstellung
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ---------- Update-Intervall ----------
  function loadInterval() {
    chrome.storage.local.get({ refreshInterval: 20 }, function (res) {
      var v = Number(res.refreshInterval) || 20;
      intervalSelect.value = String(v);
    });
  }

  function saveInterval() {
    var v = Math.min(60, Math.max(5, Number(intervalSelect.value) || 20));
    intervalSelect.value = String(v);
    chrome.storage.local.set({ refreshInterval: v }, function () {
      try { chrome.runtime.sendMessage({ type: "rescheduleBadge" }); } catch (e) {}
      intervalStatusEl.textContent = "Gespeichert (" + v + "s)";
      setTimeout(function () { intervalStatusEl.textContent = ""; }, 2000);
    });
  }

  // ---------- Init ----------
  function init() {
    loadToken();
    loadInterval();
    WE.loadNoHit().then(function (list) {
      noHit = list;
      loadCountries().then(function () {
        setNames();
        loadAlliances();
      }).catch(function () {});
    });
  }

  saveBtn.addEventListener("click", save);
  testBtn.addEventListener("click", test);
  saveIntervalBtn.addEventListener("click", saveInterval);
  countrySearch.addEventListener("change", addOneCountry);
  clearBtn.addEventListener("click", function () {
    noHit = [];
    persistNoHit();
    setNames();
    markAllianceButtons();
  });

  init();
})();
