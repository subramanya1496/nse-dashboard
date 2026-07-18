// =====================================================================================
// PLATFORM SHELL — theme, hash router, shared data store, topbar, ticker strip,
// global search and keyboard navigation. Pages register themselves via
// Platform.registerPage(route, def) from js/pages.js; widget rendering stays in
// js/app.js (window.dashboardUtils) untouched.
// =====================================================================================
(function () {
  const U = window.dashboardUtils;

  const THEME_KEY = "nse-terminal-theme";
  const NAV_KEY = "nse-terminal-nav-collapsed";

  // ---------------- Theme ----------------

  function currentTheme() {
    return document.documentElement.dataset.theme === "light" ? "light" : "dark";
  }

  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* private mode */ }
  }

  function toggleTheme() {
    setTheme(currentTheme() === "dark" ? "light" : "dark");
  }

  // ---------------- Data store (loaded once, shared by every page) ----------------

  const store = {
    loaded: false,
    loading: null,
    data: null,

    async load(force = false) {
      if (this.loaded && !force) return this.data;
      if (this.loading && !force) return this.loading;
      this.loading = (async () => {
        const [meta, flagDefinitions] = await Promise.all([U.loadMeta(), U.loadFlagDefinitions()]);
        const [stocks, sectors, portfolio, market, news, changes, runReport, validation] = await Promise.all([
          U.loadAllStocks(meta),
          U.loadSectors().catch(() => []),
          U.loadPortfolio().catch(() => ({ holdings: [] })),
          U.loadMarket(),
          U.loadNews(),
          U.loadChanges(),
          U.loadRunReport(),
          U.loadValidationReport(),
        ]);
        const stocksBySymbol = Object.fromEntries(stocks.map((s) => [s.symbol, s]));
        U.setSectorContext(sectors);
        this.data = { meta, flagDefinitions, stocks, stocksBySymbol, sectors, portfolio, market, news, changes, runReport, validation };
        this.loaded = true;
        return this.data;
      })();
      try {
        return await this.loading;
      } finally {
        this.loading = null;
      }
    },
  };

  // ---------------- Router ----------------

  const pages = new Map();

  function registerPage(route, def) {
    pages.set(route, def);
  }

  function parseHash() {
    const hash = location.hash.replace(/^#\/?/, "");
    const [path, queryString] = hash.split("?");
    const params = new URLSearchParams(queryString || "");
    return { route: path || "dashboard", params };
  }

  function navigate(route, params = {}) {
    const qs = new URLSearchParams(params).toString();
    const target = `#/${route === "dashboard" ? "" : route}${qs ? `?${qs}` : ""}`;
    if (location.hash === target) {
      renderCurrentPage(); // same-route navigation (e.g. new query) — re-render
    } else {
      location.hash = target;
    }
  }

  let currentRoute = null;
  let searchHandler = null; // a page (watchlist) can take live ownership of the search box

  async function renderCurrentPage() {
    const { route, params } = parseHash();
    const def = pages.get(route) || pages.get("dashboard");
    const routeName = pages.has(route) ? route : "dashboard";
    const main = document.getElementById("page");

    // Topbar + nav state
    document.getElementById("topbar-crumb").textContent = def.crumb || "";
    document.getElementById("topbar-title").textContent = def.title;
    document.title = `NSE Terminal — ${def.title}`;
    document.querySelectorAll(".nav-item[data-route]").forEach((a) => {
      if (a.dataset.route === routeName) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    closeMobileNav();

    // A page must opt back in to search ownership on every render.
    searchHandler = null;
    const countEl = document.getElementById("global-search-count");
    if (countEl) countEl.textContent = "";

    const changedRoute = currentRoute !== routeName;
    currentRoute = routeName;

    // Skeleton while the store loads the first time
    if (!store.loaded) {
      main.innerHTML = `
        <div class="kpi-row">${'<div class="skeleton" style="height:86px"></div>'.repeat(5)}</div>
        <div class="skeleton" style="height:220px"></div>
        <div class="skeleton" style="height:320px"></div>`;
    }

    let data;
    try {
      data = await store.load();
    } catch (err) {
      console.error(err);
      main.innerHTML = `<div class="panel"><div class="empty-note">Failed to load data: ${err.message}. Run the pipeline first (python -m src.pipeline) and reload.</div></div>`;
      return;
    }

    // Guard against a stale async render after fast navigation
    if (currentRoute !== routeName) return;

    main.innerHTML = "";
    // retrigger the page-enter animation on route change
    if (changedRoute) {
      main.style.animation = "none";
      void main.offsetWidth;
      main.style.animation = "";
      main.scrollTop = 0;
      window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
    }
    def.render(main, data, params);
  }

  // ---------------- Topbar: market status + data age ----------------

  function marketStatusIST() {
    const ist = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const day = ist.getDay();
    const mins = ist.getHours() * 60 + ist.getMinutes();
    if (day === 0 || day === 6) return { label: "Closed · weekend", cls: "closed" };
    if (mins >= 540 && mins < 555) return { label: "Pre-open", cls: "pre" };
    if (mins >= 555 && mins < 930) return { label: "Market open", cls: "open" };
    return { label: "Market closed", cls: "closed" };
  }

  // The dashboard is not a live ticker — prices only move when the pipeline runs — so
  // the data age is always shown, flagged amber once old enough to mean a missed run.
  function relativeAge(iso) {
    const then = new Date(iso).getTime();
    if (isNaN(then)) return { text: "age unknown", stale: true };
    const mins = (Date.now() - then) / 60000;
    if (mins < 1) return { text: "just now", stale: false };
    if (mins < 60) return { text: `${Math.round(mins)}m ago`, stale: false };
    const hrs = mins / 60;
    if (hrs < 24) return { text: `${Math.round(hrs)}h ago`, stale: false };
    const days = hrs / 24;
    return { text: `${Math.round(days)}d ago`, stale: days >= 3 };
  }

  function renderTopbarStatus(meta) {
    const status = marketStatusIST();
    const statusEl = document.getElementById("market-status");
    statusEl.innerHTML = `<span class="status-dot ${status.cls}"></span><span class="label-text">${status.label}</span>`;
    const age = relativeAge(meta.run_at);
    const ageEl = document.getElementById("data-age");
    ageEl.textContent = `data ${age.text}${age.stale ? " ⚠" : ""}`;
    ageEl.classList.toggle("stale", age.stale);
    ageEl.title = `Pipeline last published ${U.formatUpdatedAt(meta.run_at)} IST. Prices only change when the pipeline runs.`;
  }

  // ---------------- Ticker strip ----------------

  function sparklineSvg(history, cls) {
    if (!Array.isArray(history) || history.length < 2) return "";
    const values = history.map((h) => h.close);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const W = 68, H = 20, pad = 1;
    const pts = values
      .map((v, i) => `${(pad + (i / (values.length - 1)) * (W - 2 * pad)).toFixed(1)},${(pad + (1 - (v - min) / span) * (H - 2 * pad)).toFixed(1)}`)
      .join(" ");
    return `<svg class="spark ${cls}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke-width="1.4" vector-effect="non-scaling-stroke"></polyline></svg>`;
  }

  function renderTickerStrip(data) {
    const el = document.getElementById("market-strip");
    const { market, stocks } = data;
    const parts = [];

    if (market && market.indices && market.indices.length) {
      market.indices.forEach((ix) => {
        const chg = U.formatChangePct(ix.change_pct);
        const isVix = ix.key === "india_vix"; // VIX rising = fear rising: amber, not emerald
        const chgCls = isVix ? (ix.change_pct > 0 ? "vix-up" : "up") : chg.cls;
        const trendCls = ix.change_pct >= 0 ? (isVix ? "amber" : "teal") : "rose";
        parts.push(`<div class="mi" title="as of ${ix.as_of}">
          <span class="mi-label">${ix.label}</span>
          <span class="mi-value">${ix.close.toLocaleString("en-IN")}</span>
          <span class="mi-chg ${chgCls}">${chg.text}</span>
          ${sparklineSvg(ix.history, trendCls)}
        </div>`);
      });
    } else {
      parts.push(`<div class="mi mi-note">Index data arrives with the next pipeline run (market.json not published yet)</div>`);
    }

    const adv = stocks.filter((s) => (s.indicators.change_pct ?? 0) > 0).length;
    const dec = stocks.filter((s) => (s.indicators.change_pct ?? 0) < 0).length;
    const flat = stocks.length - adv - dec;
    parts.push(`<div class="mi" title="Advance / decline across the ${stocks.length} tracked watchlist stocks (not exchange-wide)">
      <span class="mi-label">ADV/DEC <span class="mi-sub">watchlist</span></span>
      <span class="mi-value"><span class="up">${adv}</span> / <span class="down">${dec}</span>${flat ? ` <span class="flat">/ ${flat}</span>` : ""}</span>
      <span class="ad-bar"><span class="ad-adv" style="width:${stocks.length ? ((adv / stocks.length) * 100).toFixed(0) : 0}%"></span></span>
    </div>`);

    // Data age lives in the tape too: the topbar copy is hidden on small screens, and
    // the age must always be visible somewhere (staleness is shown, never implied).
    const age = relativeAge(data.meta.run_at);
    parts.push(`<div class="mi" title="When the pipeline last published data (IST). Prices only change when the pipeline runs — they are not live ticks.">
      <span class="mi-sub mono ${age.stale ? "stale" : ""}">data: ${U.formatUpdatedAt(data.meta.run_at)} · ${age.text}${age.stale ? " ⚠" : ""}</span>
    </div>`);

    el.innerHTML = parts.join("");
  }

  // ---------------- Global search ----------------
  // One box in the topbar drives everything. On the watchlist page it filters live
  // (the page registers a handler); on any other page, typing jumps to the watchlist
  // with the query applied — the box keeps focus across the route change.

  function setSearchHandler(fn) {
    searchHandler = fn;
  }

  function bindGlobalSearch() {
    const input = document.getElementById("global-search");
    input.addEventListener("input", () => {
      const value = input.value;
      if (searchHandler) {
        searchHandler(value);
      } else if (value.trim()) {
        navigate("watchlist", { q: value.trim() });
      }
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (currentRoute !== "watchlist") navigate("watchlist", input.value.trim() ? { q: input.value.trim() } : {});
        const list = document.getElementById("stock-list");
        if (list) list.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  }

  function jumpToStock(symbol) {
    const input = document.getElementById("global-search");
    input.value = symbol;
    navigate("watchlist", { q: symbol });
  }

  // ---------------- Keyboard shortcuts ----------------

  function bindKeyboard() {
    document.addEventListener("keydown", (e) => {
      const typing = ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName);
      if (e.key === "/" && !typing) {
        e.preventDefault();
        document.getElementById("global-search").focus();
      } else if (e.key === "Escape" && typing && document.activeElement.type === "search") {
        document.activeElement.value = "";
        document.activeElement.dispatchEvent(new Event("input", { bubbles: true }));
        document.activeElement.blur();
      }
    });
  }

  // ---------------- Mobile nav drawer ----------------

  function openMobileNav() {
    document.getElementById("app").classList.add("nav-open");
    document.getElementById("nav-toggle").setAttribute("aria-expanded", "true");
  }
  function closeMobileNav() {
    document.getElementById("app").classList.remove("nav-open");
    document.getElementById("nav-toggle").setAttribute("aria-expanded", "false");
  }

  function bindShellControls() {
    document.getElementById("theme-toggle").addEventListener("click", toggleTheme);
    document.getElementById("nav-toggle").addEventListener("click", () => {
      const app = document.getElementById("app");
      if (app.classList.contains("nav-open")) closeMobileNav();
      else openMobileNav();
    });
    document.getElementById("nav-backdrop").addEventListener("click", closeMobileNav);

    const refreshBtn = document.getElementById("refresh-btn");
    refreshBtn.addEventListener("click", async () => {
      if (refreshBtn.classList.contains("is-loading")) return;
      refreshBtn.classList.add("is-loading");
      refreshBtn.querySelector("svg").classList.add("spin");
      try {
        await store.load(true);
        renderTopbarStatus(store.data.meta);
        renderTickerStrip(store.data);
        await renderCurrentPage();
      } catch (err) {
        console.error(err);
      } finally {
        refreshBtn.classList.remove("is-loading");
        refreshBtn.querySelector("svg").classList.remove("spin");
      }
    });
  }

  // ---------------- Shared UI helpers for pages ----------------

  // Progress ring: fraction of named conditions/counts (e.g. 6/8 flags) — a count
  // made visual, never a weighted score.
  function ringHtml(fraction, label, { size = 52, stroke = 5, cls = "up", title = "" } = {}) {
    const r = (size - stroke) / 2;
    const c = 2 * Math.PI * r;
    const clamped = Math.max(0, Math.min(1, fraction ?? 0));
    const offset = c * (1 - clamped);
    return `<span class="ring" style="width:${size}px;height:${size}px" ${title ? `title="${title}"` : ""} role="img" aria-label="${label} — ${(clamped * 100).toFixed(0)}%">
      <svg width="${size}" height="${size}">
        <circle class="ring-track" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}"></circle>
        <circle class="ring-fill ${cls}" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}"
          stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"></circle>
      </svg>
      <span class="ring-label">${label}</span>
    </span>`;
  }

  // ---------------- Boot ----------------

  async function boot() {
    bindShellControls();
    bindGlobalSearch();
    bindKeyboard();
    window.addEventListener("hashchange", renderCurrentPage);

    await renderCurrentPage();
    if (store.loaded) {
      renderTopbarStatus(store.data.meta);
      renderTickerStrip(store.data);
      // Nav badges: real counts, not invented numbers
      const d = store.data;
      const oppCount = d.stocks.filter((s) => s.flags.flag_count >= 5 && (U.isNearBuyZone(s) || U.isBreakoutCandidate(s) || U.isSilentAccumulation(s))).length;
      const oppBadge = document.getElementById("nav-badge-opp");
      if (oppBadge && oppCount) oppBadge.textContent = oppCount;
      const wlBadge = document.getElementById("nav-badge-watchlist");
      if (wlBadge) wlBadge.textContent = d.stocks.length;
    }
  }

  window.Platform = {
    store,
    registerPage,
    navigate,
    jumpToStock,
    setSearchHandler,
    ringHtml,
    renderTickerStrip,
    marketStatusIST,
    relativeAge,
    boot,
  };
})();
