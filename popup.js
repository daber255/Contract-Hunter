(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

  var listEl = $("list");
  var loadingEl = $("loading");
  var errorEl = $("error");
  var tokenNotice = $("tokenNotice");
  var controls = $("controls");
  var metaEl = $("meta");
  var countdownEl = $("countdown");
  var toastEl = $("toast");
  var soundEl = null;
  try {
    soundEl = new Audio(chrome.runtime.getURL("notification-sound.mp3"));
    soundEl.volume = 0.8;
  } catch (e) { soundEl = null; }

  var auctions = [];
  var countriesLoaded = false;
  var noHitCountries = [];
  var battleMap = {};
  var prevAuctionIds = [];
  var toastTimer = null;

  var REFRESH_MS = 30000;
  var refreshTimer = null;
  var tickTimer = null;
  var refreshCountdown = 0;

  function fmtMoney(n) {
    if (n === null || n === undefined) return "–";
    var f = Number(n);
    return f.toLocaleString("de-DE", { maximumFractionDigits: 2 });
  }

  function fmtPerK(n) {
    if (n === null || n === undefined) return "–";
    var f = Number(n);
    return f.toLocaleString("de-DE", { maximumFractionDigits: 4 });
  }

  function fmtDamage(n) {
    if (n === null || n === undefined) return "–";
    var f = Number(n);
    if (f >= 1000000) return (f / 1000000).toLocaleString("de-DE", { maximumFractionDigits: 1 }) + " M";
    if (f >= 1000) return (f / 1000).toLocaleString("de-DE", { maximumFractionDigits: 0 }) + " k";
    return f.toLocaleString("de-DE");
  }

  // Bewertungs-Score: je höher, desto lohnenswerter.
  // Budgetanteil pro erwartetem Schaden + aktueller PerK als Kostenfaktor.
  function score(a) {
    var budget = Number(a.budget) || 0;
    var minDmg = Number(a.minimumDamage) || 0;
    var perK = Number(a.currentPerK) || Number(a.initialPerK) || 0;
    if (minDmg <= 0) return 0;
    var effectiveK = minDmg / 1000;
    var perKDamage = effectiveK > 0 ? budget / effectiveK : 0;
    var s = 0;
    // hohe Per-K-Auszahlung ist gut (Country zahlt mehr pro 1k Schaden)
    s += perK * 100;
    // hohes Gesamtbudget ist gut
    s += Math.log10(budget + 1) * 8;
    // professionalisiert/niedrige Damage-Anforderung leicht positiv
    if (Number(minDmg) < 500000) s += 2;
    return Math.round(s * 100) / 100;
  }

  function getFilteredSorted() {
    var country = $("filterCountry").value;
    var side = $("filterSide").value;
    var proOnly = $("filterProOnly").checked;
    var noHitOn = $("filterNoHit").checked;
    var sortBy = $("sortBy").value;

    var filtered = auctions.filter(function (a) {
      if (country && a.forCountry && a.forCountry !== country) return false;
      if (side && a.forCountrySide && a.forCountrySide !== side) return false;
      if (proOnly && !a.professionalsOnly) return false;
      if (noHitOn && noHitCountries.length) {
        var opp = WE.getOpponentCountry(a, battleMap);
        // Unbekannter Gegner (Battle nicht auflösbar) → sichtbar lassen.
        if (opp && noHitCountries.indexOf(opp) !== -1) return false;
      }
      return true;
    });

    filtered.sort(function (x, y) {
      switch (sortBy) {
        case "budget": return (Number(y.budget) || 0) - (Number(x.budget) || 0);
        case "perK": return (Number(x.currentPerK) || 0) - (Number(y.currentPerK) || 0);
        case "expires":
          return new Date(x.expiresAt) - new Date(y.expiresAt);
        case "payout": return (Number(y.currentPayout) || 0) - (Number(x.currentPayout) || 0);
        default: return score(y) - score(x);
      }
    });
    return filtered;
  }

  function render() {
    var list = getFilteredSorted();
    listEl.innerHTML = "";

    if (!list.length) {
      listEl.innerHTML = '<li class="state">Keine Contracts gefunden.</li>';
      listEl.classList.remove("hidden");
      metaEl.textContent = "0 Contracts";
      return;
    }

    list.forEach(function (a) {
      listEl.appendChild(renderItem(a));
    });
    metaEl.textContent = list.length + " Contract" + (list.length === 1 ? "" : "s");
    listEl.classList.remove("hidden");
  }

  function renderItem(a) {
    var li = document.createElement("li");
    li.className = "list-item";

    var side = a.forCountrySide || "";
    var bidCount = (a.bids && a.bids.length) || 0;
    var expiry = a.expiresAt ? new Date(a.expiresAt).getTime() : 0;

    var head = document.createElement("div");
    head.className = "item-head";
    var title = document.createElement("div");
    title.className = "item-title";
    var oppId = WE.getOpponentCountry(a, battleMap);
    var scopeTag = a.roundNumber != null ? "Runde " + a.roundNumber : "Schlacht";
    var titleName = document.createElement("span");
    titleName.textContent = WE.countryName(a.forCountry) || "Unbekannt";
    title.appendChild(titleName);
    var sideEl = document.createElement("span");
    sideEl.className = "side-tag " + side;
    sideEl.textContent = side === "attacker" ? "Angreifer" : "Verteidiger";
    title.appendChild(sideEl);
    var scopeEl = document.createElement("span");
    scopeEl.className = "scope-tag";
    scopeEl.textContent = scopeTag;
    title.appendChild(scopeEl);
    var oppEl = document.createElement("span");
    oppEl.className = "opponent-tag";
    oppEl.textContent = "vs. " + (WE.countryName(oppId) || "?");
    title.appendChild(oppEl);
    if (a.professionalsOnly) {
      var proEl = document.createElement("span");
      proEl.className = "bids-badge";
      proEl.textContent = "Pro";
      title.appendChild(proEl);
    }
    var bidBadge = document.createElement("span");
    bidBadge.className = "bids-badge" + (bidCount ? " clickable" : "");
    bidBadge.textContent = bidCount + " Bid" + (bidCount === 1 ? "" : "s");
    head.appendChild(title);
    head.appendChild(bidBadge);

    var grid = document.createElement("div");
    grid.className = "item-grid";
    grid.appendChild(cell("Budget", fmtMoney(a.budget), ["v", "budget"]));
    grid.appendChild(cell("Min. Schaden", fmtDamage(a.minimumDamage), ["v", "value-high"]));
    grid.appendChild(cell("PerK", fmtPerK(a.currentPerK), ["v", "perk", "perk-high", (a.currentPerK <= a.initialPerK ? "low" : "")]));
    grid.appendChild(countdownCell(expiry));

    var bidSection = null;
    if (bidCount) {
      bidSection = document.createElement("div");
      bidSection.className = "bid-section hidden";
      (a.bids || []).forEach(function (b) {
        var row = document.createElement("div");
        row.className = "bid-row";
        var userName = document.createElement("span");
        userName.className = "bid-user";
        userName.textContent = b.user || b.mu || "Unbekannt";
        row.appendChild(userName);
        var perK = document.createElement("span");
        perK.className = "bid-perk";
        perK.textContent = fmtPerK(b.perK);
        if (b.perK && a.initialPerK && b.perK <= a.initialPerK) perK.classList.add("low");
        row.appendChild(perK);
        var payout = document.createElement("span");
        payout.className = "bid-payout";
        payout.textContent = fmtMoney(b.payout);
        row.appendChild(payout);
        var time = document.createElement("span");
        time.className = "bid-time";
        time.textContent = b.bidAt ? timeAgo(b.bidAt) : "";
        row.appendChild(time);
        bidSection.appendChild(row);
      });
    }

    var actions = document.createElement("div");
    actions.className = "item-actions";
    var bidLink = document.createElement("a");
    bidLink.className = "bid-btn";
    bidLink.href = "https://app.warera.io/battle/" + encodeURIComponent(a.battle);
    bidLink.target = "_blank";
    bidLink.rel = "noopener";
    bidLink.textContent = "Im Spiel ansehen & bieten";
    actions.appendChild(bidLink);

    li.appendChild(head);
    li.appendChild(grid);
    if (bidSection) li.appendChild(bidSection);
    li.appendChild(actions);

    if (bidCount) {
      bidBadge.addEventListener("click", function () {
        bidSection.classList.toggle("hidden");
      });
    }
    return li;
  }

  function cell(k, v, classes) {
    var div = document.createElement("div");
    div.className = "grid-cell";
    var kEl = document.createElement("span");
    kEl.className = "k";
    kEl.textContent = k;
    div.appendChild(kEl);
    var vEl = document.createElement("span");
    (Array.isArray(classes) ? classes : []).forEach(function (c) {
      if (c) vEl.classList.add(c);
    });
    vEl.textContent = String(v);
    div.appendChild(vEl);
    return div;
  }

  function countdownCell(endMs) {
    var div = document.createElement("div");
    div.className = "grid-cell";
    var kEl = document.createElement("span");
    kEl.className = "k";
    kEl.textContent = "Endet";
    var vEl = document.createElement("span");
    vEl.className = "v countdown";
    if (endMs) div.setAttribute("data-end", String(endMs));
    updateCountdown(vEl, endMs);
    div.appendChild(kEl);
    div.appendChild(vEl);
    return div;
  }

  function updateCountdown(el, endMs) {
    if (!endMs) { el.textContent = "–"; return; }
    var diff = endMs - Date.now();
    if (diff <= 0) { el.textContent = "~abgelaufen~"; el.classList.add("soon"); el.classList.remove("warn"); return; }
    var h = Math.floor(diff / 3600000);
    var m = Math.floor((diff % 3600000) / 60000);
    var s = Math.floor((diff % 60000) / 1000);
    el.textContent = pad(h) + ":" + pad(m) + ":" + pad(s);
    if (h < 5) el.classList.add("soon");
    else if (h < 24) el.classList.add("warn");
  }

  function startTicker() {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(function () {
      document.querySelectorAll(".countdown").forEach(function (el) {
        var grid = el.closest(".grid-cell");
        if (!grid) return;
        updateCountdown(el, grid.getAttribute("data-end") ? Number(grid.getAttribute("data-end")) : 0);
      });
    }, 1000);
  }

  function pad(n) { return String(n).padStart(2, "0"); }

  function timeAgo(dateStr) {
    var diff = Date.now() - new Date(dateStr).getTime();
    if (diff < 0) return "gerade eben";
    var s = Math.floor(diff / 1000);
    if (s < 60) return "vor " + s + "s";
    var m = Math.floor(s / 60);
    if (m < 60) return "vor " + m + "Min.";
    var h = Math.floor(m / 60);
    if (h < 24) return "vor " + h + "Std.";
    var d = Math.floor(h / 24);
    return "vor " + d + "T.";
  }

  function showLoading() {
    loadingEl.classList.remove("hidden");
    errorEl.classList.add("hidden");
    listEl.classList.add("hidden");
  }

  function showError(msg) {
    stopTicker();
    loadingEl.classList.add("hidden");
    errorEl.classList.remove("hidden");
    errorEl.textContent = msg;
  }

  function hasToken() {
    return Boolean(window.__token);
  }

  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.remove("hidden");
    requestAnimationFrame(function () { toastEl.classList.add("show"); });
    if (soundEl) {
      soundEl.currentTime = 0;
      soundEl.play().catch(function () {});
    }
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove("show");
      setTimeout(function () { toastEl.classList.add("hidden"); }, 300);
    }, 5000);
  }

  function detectNewAuctions() {
    if (!prevAuctionIds.length) return;
    var newOnes = auctions.filter(function (a) { return prevAuctionIds.indexOf(a._id) === -1; });
    if (newOnes.length) showToast(newOnes.length + " neuer Contract gefunden!");
  }

  function loadData() {
    if (auctions.length) prevAuctionIds = auctions.map(function (a) { return a._id; });
    showLoading();

    var countriesP;
    if (countriesLoaded) {
      countriesP = Promise.resolve();
    } else {
      countriesP = WE.countryMap().then(function () { countriesLoaded = true; populateCountryFilter(); });
    }

    var noHitP = WE.loadNoHit().then(function (list) { noHitCountries = list; }).catch(function () { noHitCountries = []; });

    countriesP
      .then(function () {
        return WE.collectAllAuctions({ limit: 50, status: "active" });
      })
      .then(function (list) {
        auctions = list || [];
        var battleIds = [];
        (auctions || []).forEach(function (a) {
          if (a && a.battle) battleIds.push(a.battle);
        });
        var battlesP = WE.resolveBattleMap(battleIds).then(function (map) {
          battleMap = map || {};
        }).catch(function () { battleMap = {}; });
        return Promise.all([noHitP, battlesP]).then(function () { return auctions; });
      })
      .then(function () {
        render();
        stopLoading();
        startTicker();
        scheduleRefresh();
        detectNewAuctions();
      })
      .catch(function (err) {
        if (err && err.message === "NO_TOKEN") {
          showTokenNotice();
        } else {
          showError("Fehler beim Laden: " + (err.message || err));
        }
      });
  }

  function stopLoading() {
    loadingEl.classList.add("hidden");
    errorEl.classList.add("hidden");
  }

  function stopTicker() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  }

  function showTokenNotice() {
    stopTicker();
    stopLoading();
    tokenNotice.classList.remove("hidden");
    controls.classList.add("hidden");
    metaEl.textContent = "";
  }

  function showControls(token) {
    window.__token = token;
    tokenNotice.classList.add("hidden");
    controls.classList.remove("hidden");
  }

  function populateCountryFilter() {
    var select = $("filterCountry");
    var selected = select.value;
    select.innerHTML = "";
    var def = document.createElement("option");
    def.value = "";
    def.textContent = "Alle";
    select.appendChild(def);

    if (WE.countries && Array.isArray(WE.countries)) {
      WE.countries.slice().sort(function (a, b) {
        return (a.name || "").localeCompare(b.name || "");
      }).forEach(function (c) {
        var opt = document.createElement("option");
        opt.value = c._id;
        opt.textContent = c.name || c.code || c._id;
        select.appendChild(opt);
      });
    }
    if (selected) select.value = selected;
  }

  function scheduleRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshCountdown = Math.floor(REFRESH_MS / 1000);
    function tick() {
      if (refreshCountdown <= 0) { countdownEl.textContent = ""; loadData(); return; }
      countdownEl.textContent = refreshCountdown + "s";
      refreshCountdown--;
      refreshTimer = setTimeout(tick, 1000);
    }
    tick();
  }

  function init() {
    chrome.storage.local.get({ apiToken: "", noHitEnabled: true, refreshInterval: 20 }, function (res) {
      var sec = Number(res.refreshInterval) || 20;
      REFRESH_MS = Math.min(60, Math.max(5, sec)) * 1000;
      countdownEl.textContent = sec + "s";
      $("filterNoHit").checked = res.noHitEnabled !== false;
      if (res.apiToken) {
        showControls(res.apiToken);
        loadData();
      } else {
        showTokenNotice();
      }
    });
  }

  // Events
  $("refresh").addEventListener("click", loadData);
  $("settings").addEventListener("click", function () {
    chrome.runtime.openOptionsPage();
  });
  $("openOptions").addEventListener("click", function () {
    chrome.runtime.openOptionsPage();
  });

  ["filterCountry", "filterSide", "sortBy"].forEach(function (id) {
    $(id).addEventListener("change", render);
  });
  $("filterProOnly").addEventListener("change", render);
  $("filterNoHit").addEventListener("change", function () {
    render();
    chrome.storage.local.set({ noHitEnabled: $("filterNoHit").checked });
    if (window.__token) {
      // Badge im Hintergrund sofort anpassen, damit er konsistent bleibt.
      try { chrome.runtime.sendMessage({ type: "updateBadge" }); } catch (e) {}
    }
  });

  init();
})();
