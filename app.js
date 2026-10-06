/* ================================================================
   Paisa Khata — app.js (Google Sheets edition)
   Backend : Apps Script Web App -> Google Sheet "Paisa Khata DB"
   Cache   : localStorage keeps a per-user copy so the app opens
             instantly and works offline; writes that fail go to a
             sync queue and are retried on reload / when back online.
   ================================================================ */

(() => {
  "use strict";

  /* ---------------- config ---------------- */
  const API_URL = "https://script.google.com/macros/s/AKfycbw7UUqWltEKGvb_OH0R05v9Jl9CqfMsDJXETgQTkNkWZrxxyK5pq7Azbp0ZeiOky90C/exec";

  const LS_STORE = "pk_store";     // cache: { [username]: { categories, expenses } }
  const LS_SESSION = "pk_session"; // { username, name }
  const LS_QUEUE = "pk_queue";     // pending POST bodies (offline writes)
  const LS_THEME = "pk_theme";

  const DEFAULT_CATS = ["Food", "Travel", "Shopping", "Bills", "Health", "Entertainment", "Other"];
  const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const DONUT_COLORS = ["#6366f1","#d946ef","#14b8a6","#f59e0b","#ef5a6f","#3b82f6","#a855f7","#10b981","#ec4899","#64748b"];

  const CAT_ICONS = [
    [/food|lunch|dinner|meal|khana|grocery|kirana/i, "🍛"],
    [/travel|trip|fuel|petrol|cab|auto|bus|train|flight/i, "🛺"],
    [/shop/i, "🛍️"],
    [/bill|recharge|electric|rent|emi|wifi|internet/i, "🧾"],
    [/health|medic|doctor|gym|fitness/i, "💊"],
    [/entertain|movie|game|ott|fun/i, "🎬"],
    [/edu|book|course|study/i, "📚"],
    [/gift|donat|puja|temple/i, "🪔"],
  ];

  /* ---------------- state ---------------- */
  let store = readJSON(LS_STORE, {});
  let queue = readJSON(LS_QUEUE, []);
  let currentUser = null;
  let editingId = null;
  let deletingId = null;

  const $ = (id) => document.getElementById(id);

  /* ---------------- helpers ---------------- */
  function readJSON(key, fallback) {
    try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; }
    catch { return fallback; }
  }
  const saveStore = () => localStorage.setItem(LS_STORE, JSON.stringify(store));
  const saveQueue = () => localStorage.setItem(LS_QUEUE, JSON.stringify(queue));

  const fmtINR = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 });
  const money = (n) => fmtINR.format(n).replace(/\.00$/, "");
  const todayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const prettyDate = (iso) => {
    const [y, m, d] = String(iso).split("-").map(Number);
    if (!y || !m || !d) return String(iso);
    return `${d} ${MONTHS[m - 1].slice(0, 3)} ${y}`;
  };
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const catIcon = (cat) => { for (const [re, ico] of CAT_ICONS) if (re.test(cat)) return ico; return "💸"; };

  function userData() {
    if (!store[currentUser.username]) {
      store[currentUser.username] = { categories: [...DEFAULT_CATS], expenses: [] };
    }
    const d = store[currentUser.username];
    if (!Array.isArray(d.categories) || !d.categories.length) d.categories = [...DEFAULT_CATS];
    if (!Array.isArray(d.expenses)) d.expenses = [];
    return d;
  }

  function toast(msg, ico = "✅") {
    const t = document.createElement("div");
    t.className = "toast";
    t.innerHTML = `<span>${ico}</span><span>${esc(msg)}</span>`;
    $("toastZone").appendChild(t);
    setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 320); }, 2600);
  }

  function setLoading(btn, on) {
    if (!btn) return;
    btn.disabled = on;
    btn.classList.toggle("loading", on);
  }

  function countUp(el, target, isMoney) {
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || target === 0) { el.textContent = isMoney ? money(target) : target; return; }
    const dur = 600, t0 = performance.now();
    (function step(t) {
      const p = Math.min(1, (t - t0) / dur);
      const v = target * (1 - Math.pow(1 - p, 3));
      el.textContent = isMoney ? money(Math.round(v)) : Math.round(v);
      if (p < 1) requestAnimationFrame(step);
    })(t0);
  }

  /* ================================================================
     API LAYER (Apps Script)
     ================================================================ */
  async function apiGet(params) {
    const r = await fetch(API_URL + "?" + new URLSearchParams(params));
    return r.json();
  }
  async function apiPost(body) {
    // text/plain avoids a CORS preflight, which Apps Script can't answer
    const r = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(body),
    });
    return r.json();
  }

  /**
   * Write to the sheet.
   * {ok}       server accepted — apply locally + success toast
   * {queued}   offline — apply locally, retry later
   * {rejected} server said no (duplicate etc.) — do NOT apply locally
   */
  async function syncWrite(body) {
    try {
      const res = await apiPost(body);
      if (res.ok) return { ok: true };
      toast(res.error || "Server rejected the change", "⚠️");
      return { rejected: true };
    } catch {
      queue.push(body);
      saveQueue();
      toast("Offline — saved on device, will sync later", "📡");
      return { queued: true };
    }
  }

  async function flushQueue() {
    while (queue.length) {
      try {
        const res = await apiPost(queue[0]);
        queue.shift();            // sent (or rejected as duplicate) — drop it
        saveQueue();
        if (!res.ok && res.error) console.warn("Sync skipped:", res.error);
      } catch {
        return false;             // still offline — try again later
      }
    }
    return true;
  }

  async function refreshFromServer() {
    if (!currentUser) return;
    try {
      await flushQueue();
      const res = await apiGet({ action: "getData", username: currentUser.username });
      if (res.ok) {
        store[currentUser.username] = res.data;
        saveStore();
        refreshTodaySpent();
        const active = document.querySelector(".page.active");
        if (active?.id === "page-list") { buildListFilterOptions(); renderList(); }
        if (active?.id === "page-dash") { buildDashFilterOptions(); renderDash(); }
        if (active?.id === "page-add") renderCatGrid();
      }
    } catch { /* offline — cached data stays */ }
  }

  window.addEventListener("online", () => { flushQueue().then((done) => done && refreshFromServer()); });

  /* ---------------- theme ---------------- */
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    localStorage.setItem(LS_THEME, t);
  }
  function toggleTheme() {
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  }
  applyTheme(localStorage.getItem(LS_THEME) || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  $("themeToggle").addEventListener("click", toggleTheme);
  $("authThemeToggle").addEventListener("click", toggleTheme);

  /* ---------------- boot ---------------- */
  function boot() {
    const raw = localStorage.getItem(LS_SESSION);
    if (raw) {
      try { currentUser = JSON.parse(raw); }
      catch { currentUser = { username: raw, name: raw }; } // old session format
      if (currentUser?.username) {
        enterApp();            // instant, from cache
        refreshFromServer();   // then sync in background
        return;
      }
    }
    $("authView").classList.remove("hidden");
  }

  /* ================================================================
     AUTH
     ================================================================ */
  function setAuthMode(reg) {
    $("loginForm").classList.toggle("hidden", reg);
    $("registerForm").classList.toggle("hidden", !reg);
    $("tabLogin").classList.toggle("active", !reg);
    $("tabRegister").classList.toggle("active", reg);
    $("tabLogin").setAttribute("aria-selected", String(!reg));
    $("tabRegister").setAttribute("aria-selected", String(reg));
    document.querySelector(".auth-tabs").classList.toggle("reg", reg);
  }
  $("tabLogin").onclick = () => setAuthMode(false);
  $("tabRegister").onclick = () => setAuthMode(true);
  $("goRegister").onclick = () => setAuthMode(true);
  $("goLogin").onclick = () => setAuthMode(false);

  document.querySelectorAll(".pass-eye").forEach((b) => {
    b.addEventListener("click", () => {
      const inp = $(b.dataset.eye);
      inp.type = inp.type === "password" ? "text" : "password";
    });
  });

  const setErr = (id, msg) => { $(id).textContent = msg || ""; };

  function startSession(user, data) {
    currentUser = { username: user.username, name: user.name || user.username };
    localStorage.setItem(LS_SESSION, JSON.stringify(currentUser));
    if (data) { store[currentUser.username] = data; saveStore(); }
    enterApp();
  }

  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const u = $("loginUser").value.trim();
    const p = $("loginPass").value;
    setErr("loginUserErr"); setErr("loginPassErr");
    if (!u) return setErr("loginUserErr", "Username is required.");
    if (!p) return setErr("loginPassErr", "Password is required.");

    const btn = e.target.querySelector(".btn-primary");
    setLoading(btn, true);
    try {
      const res = await apiGet({ action: "login", username: u, password: p });
      if (!res.ok) {
        setErr(/password/i.test(res.error || "") ? "loginPassErr" : "loginUserErr", res.error || "Login failed.");
        return;
      }
      startSession(res.user, res.data);
      toast(`Welcome back, ${res.user.name || res.user.username}!`, "👋");
    } catch {
      setErr("loginPassErr", "Can't reach the server — check your internet.");
    } finally {
      setLoading(btn, false);
    }
  });

  $("registerForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("regName").value.trim();
    const u = $("regUser").value.trim();
    const p = $("regPass").value;
    const p2 = $("regPass2").value;
    ["regNameErr","regUserErr","regPassErr","regPass2Err"].forEach((x) => setErr(x));

    let bad = false;
    if (!name) { setErr("regNameErr", "Tell us your name."); bad = true; }
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(u)) { setErr("regUserErr", "3–20 chars: letters, numbers, underscore."); bad = true; }
    if (p.length < 6 || !/[a-zA-Z]/.test(p) || !/\d/.test(p)) { setErr("regPassErr", "Min 6 chars with a letter and a number."); bad = true; }
    if (p !== p2) { setErr("regPass2Err", "Passwords don't match."); bad = true; }
    if (bad) return;

    const btn = e.target.querySelector(".btn-primary");
    setLoading(btn, true);
    try {
      const res = await apiPost({ action: "register", username: u, password: p, name });
      if (!res.ok) {
        setErr("regUserErr", res.error || "Registration failed.");
        return;
      }
      startSession(res.user, res.data);
      toast(`Account created. Welcome, ${name}!`, "🎉");
    } catch {
      setErr("regUserErr", "Can't reach the server — check your internet.");
    } finally {
      setLoading(btn, false);
    }
  });

  function doLogout() {
    localStorage.removeItem(LS_SESSION);
    currentUser = null;
    $("appView").classList.add("hidden");
    $("authView").classList.remove("hidden");
    setAuthMode(false);
    $("loginForm").reset();
  }
  $("logoutBtn").addEventListener("click", doLogout);
  $("logoutTop").addEventListener("click", doLogout);

  /* ================================================================
     APP SHELL
     ================================================================ */
  const PAGE_TITLES = { add: "Add Spent", list: "All Spent", dash: "Dashboard" };

  function enterApp() {
    $("authView").classList.add("hidden");
    $("appView").classList.remove("hidden");
    const n = currentUser.name || currentUser.username;
    $("userName").textContent = n;
    $("userAvatar").textContent = n[0].toUpperCase();
    const h = new Date().getHours();
    $("greet").textContent = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
    $("dateInput").value = todayStr();
    $("addDateLabel").textContent = prettyDate(todayStr());
    userData();
    saveStore();
    renderCatGrid();
    refreshTodaySpent();
    showPage("add");
  }

  function showPage(key) {
    document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
    $("page-" + key).classList.add("active");
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.page === key));
    $("pageTitle").textContent = PAGE_TITLES[key];
    if (key === "list") { buildListFilterOptions(); renderList(); }
    if (key === "dash") { buildDashFilterOptions(); renderDash(); }
  }
  document.querySelectorAll(".nav-btn").forEach((b) => b.addEventListener("click", () => showPage(b.dataset.page)));
  document.addEventListener("click", (e) => {
    const j = e.target.closest("[data-page-jump]");
    if (j) showPage(j.dataset.pageJump);
  });

  function refreshTodaySpent() {
    const t = todayStr();
    const sum = userData().expenses.filter((e) => e.date === t).reduce((a, e) => a + e.amount, 0);
    $("todaySpent").textContent = money(sum);
  }

  /* ================================================================
     PAGE 1 — ADD SPENT
     ================================================================ */
  let selectedCat = "";

  function renderCatGrid() {
    const grid = $("catGrid");
    grid.innerHTML = "";
    userData().categories.forEach((c) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "cat-pill" + (c === selectedCat ? " selected" : "");
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(c === selectedCat));
      b.textContent = `${catIcon(c)} ${c}`;
      b.title = c;
      b.onclick = () => { selectedCat = c; renderCatGrid(); setErr("categoryErr"); };
      grid.appendChild(b);
    });
  }

  $("amountInput").addEventListener("input", (e) => {
    let v = e.target.value.replace(/[^\d.]/g, "");
    const parts = v.split(".");
    if (parts.length > 2) v = parts[0] + "." + parts.slice(1).join("");
    if (parts[1]?.length > 2) v = parts[0] + "." + parts[1].slice(0, 2);
    e.target.value = v;
    setErr("amountErr");
  });

  document.querySelectorAll(".quick-amounts .chip").forEach((c) => {
    c.addEventListener("click", () => {
      $("amountInput").value = c.dataset.amt;
      setErr("amountErr");
      $("amountInput").focus();
    });
  });

  $("manageCatsBtn").addEventListener("click", () => openDrawer("cat"));

  $("spentForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const amount = parseFloat($("amountInput").value);
    const details = $("detailsInput").value.trim();
    const date = $("dateInput").value || todayStr();
    let bad = false;
    setErr("amountErr"); setErr("detailsErr"); setErr("categoryErr");
    if (!amount || amount <= 0) { setErr("amountErr", "Enter an amount greater than 0."); bad = true; }
    if (!details) { setErr("detailsErr", "Add a short note about this spent."); bad = true; }
    if (!selectedCat) { setErr("categoryErr", "Pick a category."); bad = true; }
    if (bad) return;

    const expense = { id: uid(), details, category: selectedCat, amount, date, createdAt: new Date().toISOString() };
    const btn = e.target.querySelector(".btn-primary");
    setLoading(btn, true);

    const res = await syncWrite({ action: "addExpense", username: currentUser.username, expense });
    setLoading(btn, false);
    if (res.rejected) return;

    userData().expenses.push(expense);
    saveStore();
    refreshTodaySpent();

    btn.classList.add("saved");
    setTimeout(() => btn.classList.remove("saved"), 550);
    if (res.ok) toast(`${money(amount)} added to ${expense.category}`);

    $("amountInput").value = "";
    $("detailsInput").value = "";
    selectedCat = "";
    renderCatGrid();
    $("amountInput").focus();
  });

  /* ================================================================
     CATEGORY DRAWER
     ================================================================ */
  function openDrawer(which) {
    $(which + "Overlay").classList.remove("hidden");
    const d = $(which + "Drawer");
    d.classList.remove("hidden", "closing");
    if (which === "cat") renderCatManage();
    d.querySelector("input, select")?.focus();
  }
  function closeDrawer(which) {
    const d = $(which + "Drawer");
    d.classList.add("closing");
    setTimeout(() => {
      d.classList.add("hidden");
      $(which + "Overlay").classList.add("hidden");
    }, 240);
  }
  document.querySelectorAll(".drawer-close").forEach((b) => b.addEventListener("click", () => closeDrawer(b.dataset.close)));
  $("catOverlay").addEventListener("click", () => closeDrawer("cat"));
  $("editOverlay").addEventListener("click", () => closeDrawer("edit"));
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("catDrawer").classList.contains("hidden")) closeDrawer("cat");
    if (!$("editDrawer").classList.contains("hidden")) closeDrawer("edit");
    if (!$("confirmOverlay").classList.contains("hidden")) hideConfirm();
  });

  function renderCatManage() {
    const ul = $("catManageList");
    ul.innerHTML = "";
    const counts = {};
    userData().expenses.forEach((e) => { counts[e.category] = (counts[e.category] || 0) + 1; });
    userData().categories.forEach((c) => {
      const li = document.createElement("li");
      const used = counts[c] || 0;
      li.innerHTML = `<span>${catIcon(c)} ${esc(c)}</span>
        <span class="cat-count">${used ? used + " record" + (used > 1 ? "s" : "") : "unused"}</span>
        <button class="icon-btn del" title="Delete category" aria-label="Delete ${esc(c)}">🗑</button>`;
      const delBtn = li.querySelector("button");
      delBtn.onclick = async () => {
        if (used) { toast(`"${c}" has ${used} record(s) — move or delete them first`, "⚠️"); return; }
        delBtn.disabled = true;
        const res = await syncWrite({ action: "deleteCategory", username: currentUser.username, category: c });
        delBtn.disabled = false;
        if (res.rejected) return;
        userData().categories = userData().categories.filter((x) => x !== c);
        if (selectedCat === c) selectedCat = "";
        saveStore();
        renderCatManage(); renderCatGrid(); buildListFilterOptions();
        if (res.ok) toast(`Category "${c}" deleted`, "🗑");
      };
      ul.appendChild(li);
    });
  }

  $("addCatForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = $("newCatInput").value.trim();
    setErr("catAddErr");
    if (!v) return setErr("catAddErr", "Type a category name.");
    if (userData().categories.some((c) => c.toLowerCase() === v.toLowerCase()))
      return setErr("catAddErr", "That category already exists.");

    const btn = e.target.querySelector("button");
    btn.disabled = true;
    const res = await syncWrite({ action: "addCategory", username: currentUser.username, category: v });
    btn.disabled = false;
    if (res.rejected) return;

    userData().categories.push(v);
    saveStore();
    $("newCatInput").value = "";
    renderCatManage(); renderCatGrid(); buildListFilterOptions();
    if (res.ok) toast(`Category "${v}" added`);
  });

  /* ================================================================
     PAGE 2 — ALL SPENT (filters + list)
     ================================================================ */
  const F = { search: "", cat: "", month: "", year: "", from: "", to: "" };

  function buildListFilterOptions() {
    const d = userData();
    const cats = [...new Set([...d.categories, ...d.expenses.map((e) => e.category)])];
    fillSelect($("filterCategory"), cats.map((c) => [c, c]), "All categories", F.cat);
    fillSelect($("filterMonth"), MONTHS.map((m, i) => [String(i + 1), m]), "Any month", F.month);
    const years = [...new Set(d.expenses.map((e) => e.date.slice(0, 4)))].sort().reverse();
    fillSelect($("filterYear"), years.map((y) => [y, y]), "Any year", F.year);
  }

  function fillSelect(sel, pairs, blankLabel, keep) {
    sel.innerHTML = `<option value="">${blankLabel}</option>` +
      pairs.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("");
    sel.value = pairs.some(([v]) => v === keep) ? keep : "";
  }

  function filteredExpenses() {
    return userData().expenses.filter((e) => {
      if (F.search) {
        const q = F.search.toLowerCase();
        if (!e.details.toLowerCase().includes(q) && !e.category.toLowerCase().includes(q)) return false;
      }
      if (F.cat && e.category !== F.cat) return false;
      const [y, m] = e.date.split("-");
      if (F.month && String(Number(m)) !== F.month) return false;
      if (F.year && y !== F.year) return false;
      if (F.from && e.date < F.from) return false;
      if (F.to && e.date > F.to) return false;
      return true;
    }).sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || "").localeCompare(a.createdAt || ""));
  }

  function renderActiveFilters() {
    const zone = $("activeFilters");
    zone.innerHTML = "";
    const chips = [];
    if (F.search) chips.push(["search", `🔍 "${F.search}"`]);
    if (F.cat) chips.push(["cat", `${catIcon(F.cat)} ${F.cat}`]);
    if (F.month) chips.push(["month", `📅 ${MONTHS[F.month - 1]}`]);
    if (F.year) chips.push(["year", `🗓 ${F.year}`]);
    if (F.from) chips.push(["from", `from ${prettyDate(F.from)}`]);
    if (F.to) chips.push(["to", `till ${prettyDate(F.to)}`]);
    chips.forEach(([key, label]) => {
      const b = document.createElement("button");
      b.className = "filter-chip";
      b.innerHTML = `${esc(label)} ✕`;
      b.title = "Remove this filter";
      b.onclick = () => { clearFilter(key); };
      zone.appendChild(b);
    });
    if (chips.length > 1) {
      const all = document.createElement("button");
      all.className = "filter-chip clear-all";
      all.textContent = "Clear all ✕";
      all.onclick = () => { Object.keys(F).forEach((k) => (F[k] = "")); syncFilterInputs(); renderList(); };
      zone.appendChild(all);
    }
  }

  function clearFilter(key) {
    F[key] = "";
    syncFilterInputs();
    renderList();
  }
  function syncFilterInputs() {
    $("searchInput").value = F.search;
    $("filterCategory").value = F.cat;
    $("filterMonth").value = F.month;
    $("filterYear").value = F.year;
    $("filterFrom").value = F.from;
    $("filterTo").value = F.to;
  }

  $("searchInput").addEventListener("input", (e) => { F.search = e.target.value.trim(); renderList(); });
  $("filterCategory").addEventListener("change", (e) => { F.cat = e.target.value; renderList(); });
  $("filterMonth").addEventListener("change", (e) => { F.month = e.target.value; renderList(); });
  $("filterYear").addEventListener("change", (e) => { F.year = e.target.value; renderList(); });
  $("filterFrom").addEventListener("change", (e) => { F.from = e.target.value; renderList(); });
  $("filterTo").addEventListener("change", (e) => { F.to = e.target.value; renderList(); });

  function renderList() {
    const items = filteredExpenses();
    const ul = $("spentList");
    ul.innerHTML = "";
    renderActiveFilters();

    const hasAny = userData().expenses.length > 0;
    $("listEmpty").classList.toggle("hidden", items.length > 0);
    $("listEmpty").querySelector(".empty-big").textContent = hasAny ? "No records match these filters" : "Nothing in the khata yet";
    $("listEmpty").querySelector("p:nth-of-type(2)").textContent = hasAny
      ? "Loosen a filter or clear them all." : "Add your first spent and it will show up here.";
    $("listEmpty").querySelector(".btn").classList.toggle("hidden", hasAny);
    $("listFoot").style.display = items.length ? "flex" : "none";

    items.forEach((e, i) => {
      const li = document.createElement("li");
      li.className = "spent-item";
      li.style.animationDelay = Math.min(i * 30, 300) + "ms";
      li.innerHTML = `
        <span class="item-ico">${catIcon(e.category)}</span>
        <div class="item-body">
          <p class="item-details">${esc(e.details)}</p>
          <p class="item-meta"><span class="item-cat">${esc(e.category)}</span> · ${prettyDate(e.date)}</p>
        </div>
        <span class="item-amount">${money(e.amount)}</span>
        <div class="item-actions">
          <button class="icon-btn" title="Edit" aria-label="Edit record">✏️</button>
          <button class="icon-btn del" title="Delete" aria-label="Delete record">🗑</button>
        </div>`;
      const [editBtn, delBtn] = li.querySelectorAll(".icon-btn");
      editBtn.onclick = () => openEdit(e.id);
      delBtn.onclick = () => askDelete(e.id, li);
      ul.appendChild(li);
    });

    const total = items.reduce((a, e) => a + e.amount, 0);
    $("listCount").textContent = `${items.length} record${items.length === 1 ? "" : "s"}`;
    $("listTotal").textContent = money(total);
  }

  /* ---------------- edit drawer ---------------- */
  function openEdit(id) {
    const e = userData().expenses.find((x) => x.id === id);
    if (!e) return;
    editingId = id;
    const cats = [...new Set([...userData().categories, e.category])];
    $("editCategory").innerHTML = cats.map((c) => `<option ${c === e.category ? "selected" : ""}>${esc(c)}</option>`).join("");
    $("editAmount").value = e.amount;
    $("editDetails").value = e.details;
    $("editDate").value = e.date;
    setErr("editAmountErr"); setErr("editDetailsErr");
    openDrawer("edit");
  }

  $("editAmount").addEventListener("input", (e) => {
    e.target.value = e.target.value.replace(/[^\d.]/g, "");
  });

  $("editForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const e = userData().expenses.find((x) => x.id === editingId);
    if (!e) return;
    const amount = parseFloat($("editAmount").value);
    const details = $("editDetails").value.trim();
    let bad = false;
    setErr("editAmountErr"); setErr("editDetailsErr");
    if (!amount || amount <= 0) { setErr("editAmountErr", "Enter an amount greater than 0."); bad = true; }
    if (!details) { setErr("editDetailsErr", "Details can't be empty."); bad = true; }
    if (bad) return;

    const updated = {
      id: e.id, details, category: $("editCategory").value,
      amount, date: $("editDate").value || e.date,
    };
    const btn = ev.target.querySelector(".btn-primary");
    setLoading(btn, true);
    const res = await syncWrite({ action: "updateExpense", username: currentUser.username, expense: updated });
    setLoading(btn, false);
    if (res.rejected) return;

    Object.assign(e, updated);
    saveStore();
    closeDrawer("edit");
    renderList();
    refreshTodaySpent();
    if (res.ok) toast("Record updated", "✏️");
  });

  /* ---------------- delete confirm ---------------- */
  let pendingDeleteEl = null;
  function askDelete(id, li) {
    deletingId = id;
    pendingDeleteEl = li;
    const e = userData().expenses.find((x) => x.id === id);
    $("confirmSub").textContent = e ? `${money(e.amount)} · ${e.details} — this can't be undone.` : "This can't be undone.";
    $("confirmOverlay").classList.remove("hidden");
    $("confirmDelete").focus();
  }
  function hideConfirm() { $("confirmOverlay").classList.add("hidden"); }
  $("confirmCancel").addEventListener("click", () => { hideConfirm(); deletingId = null; pendingDeleteEl = null; });
  $("confirmOverlay").addEventListener("click", (e) => { if (e.target === $("confirmOverlay")) { hideConfirm(); deletingId = null; pendingDeleteEl = null; } });

  $("confirmDelete").addEventListener("click", async () => {
    const id = deletingId, el = pendingDeleteEl;
    hideConfirm();
    deletingId = null; pendingDeleteEl = null;
    if (!id) return;

    const res = await syncWrite({ action: "deleteExpense", username: currentUser.username, id });
    if (res.rejected) return;

    el?.classList.add("removing");
    setTimeout(() => {
      const d = userData();
      d.expenses = d.expenses.filter((x) => x.id !== id);
      saveStore();
      renderList();
      refreshTodaySpent();
      if (res.ok) toast("Record deleted", "🗑");
    }, 280);
  });

  /* ================================================================
     PAGE 3 — DASHBOARD
     ================================================================ */
  const DF = { month: "", year: "", from: "", to: "" };

  function buildDashFilterOptions() {
    fillSelect($("dashMonth"), MONTHS.map((m, i) => [String(i + 1), m]), "All months", DF.month);
    const years = [...new Set(userData().expenses.map((e) => e.date.slice(0, 4)))].sort().reverse();
    fillSelect($("dashYear"), years.map((y) => [y, y]), "All years", DF.year);
    $("dashFrom").value = DF.from;
    $("dashTo").value = DF.to;
  }
  ["dashMonth", "dashYear"].forEach((id) => $(id).addEventListener("change", (e) => { DF[id === "dashMonth" ? "month" : "year"] = e.target.value; renderDash(); }));
  ["dashFrom", "dashTo"].forEach((id) => $(id).addEventListener("change", (e) => { DF[id === "dashFrom" ? "from" : "to"] = e.target.value; renderDash(); }));
  $("dashClear").addEventListener("click", () => { Object.keys(DF).forEach((k) => (DF[k] = "")); buildDashFilterOptions(); renderDash(); });

  function dashExpenses() {
    return userData().expenses.filter((e) => {
      const [y, m] = e.date.split("-");
      if (DF.month && String(Number(m)) !== DF.month) return false;
      if (DF.year && y !== DF.year) return false;
      if (DF.from && e.date < DF.from) return false;
      if (DF.to && e.date > DF.to) return false;
      return true;
    });
  }

  function renderDash() {
    const items = dashExpenses();
    const total = items.reduce((a, e) => a + e.amount, 0);

    countUp($("statTotal"), total, true);
    countUp($("statCount"), items.length, false);
    countUp($("statAvg"), items.length ? Math.round(total / items.length) : 0, true);

    const byCat = {};
    items.forEach((e) => { byCat[e.category] = (byCat[e.category] || 0) + e.amount; });
    const catEntries = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
    $("statTop").textContent = catEntries.length ? `${catIcon(catEntries[0][0])} ${catEntries[0][0]}` : "—";

    renderDonut(catEntries, total);
    renderBars(items);
    renderRecent(items);
  }

  function renderDonut(entries, total) {
    const svg = $("donutChart");
    svg.innerHTML = "";
    $("donutTotal").textContent = money(total);
    const legend = $("donutLegend");
    legend.innerHTML = "";

    const R = 82, C = 2 * Math.PI * R;
    svg.innerHTML = `<circle cx="110" cy="110" r="${R}" fill="none" stroke="var(--surface-2)" stroke-width="26"></circle>`;
    if (!total) {
      legend.innerHTML = `<li style="color:var(--muted)">No data for this period — add a spent first.</li>`;
      return;
    }
    let offset = 0;
    entries.forEach(([cat, amt], i) => {
      const frac = amt / total;
      const seg = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      seg.setAttribute("class", "seg");
      seg.setAttribute("cx", "110"); seg.setAttribute("cy", "110"); seg.setAttribute("r", R);
      seg.setAttribute("stroke", DONUT_COLORS[i % DONUT_COLORS.length]);
      seg.setAttribute("stroke-dasharray", `0 ${C}`);
      seg.setAttribute("stroke-dashoffset", String(-offset * C + C / 4));
      seg.setAttribute("stroke-linecap", "butt");
      svg.appendChild(seg);
      requestAnimationFrame(() =>
        seg.setAttribute("stroke-dasharray", `${Math.max(frac * C - 1.5, 0.5)} ${C}`)
      );
      offset += frac;

      const li = document.createElement("li");
      li.innerHTML = `<span class="dot" style="background:${DONUT_COLORS[i % DONUT_COLORS.length]}"></span>
        <span class="l-name">${esc(cat)}</span>
        <span class="l-val">${money(amt)}</span>
        <span class="l-pct">${Math.round(frac * 100)}%</span>`;
      legend.appendChild(li);
    });
  }

  function renderBars(items) {
    const wrap = $("barChart");
    wrap.innerHTML = "";
    const byMonth = {};
    items.forEach((e) => {
      const key = e.date.slice(0, 7);
      byMonth[key] = (byMonth[key] || 0) + e.amount;
    });
    const keys = Object.keys(byMonth).sort().slice(-8);
    if (!keys.length) {
      wrap.innerHTML = `<p class="bars-empty">Nothing to chart yet.</p>`;
      return;
    }
    const max = Math.max(...keys.map((k) => byMonth[k]));
    keys.forEach((k) => {
      const [y, m] = k.split("-");
      const col = document.createElement("div");
      col.className = "bar-col";
      col.innerHTML = `
        <span class="bar-val">${money(byMonth[k])}</span>
        <div class="bar" style="height:4px" title="${MONTHS[m - 1]} ${y}: ${money(byMonth[k])}"></div>
        <span class="bar-label">${MONTHS[m - 1].slice(0, 3)} ${y.slice(2)}</span>`;
      wrap.appendChild(col);
      const h = Math.max(6, (byMonth[k] / max) * 100);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        col.querySelector(".bar").style.height = h + "%";
      }));
    });
  }

  function renderRecent(items) {
    const ul = $("recentList");
    ul.innerHTML = "";
    const recent = [...items]
      .sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || "").localeCompare(a.createdAt || ""))
      .slice(0, 6);
    if (!recent.length) {
      ul.innerHTML = `<li style="color:var(--muted); border:none;">No entries in this period.</li>`;
      return;
    }
    recent.forEach((e) => {
      const li = document.createElement("li");
      li.innerHTML = `
        <div>
          <div>${catIcon(e.category)} ${esc(e.details)}</div>
          <div class="r-meta">${esc(e.category)} · ${prettyDate(e.date)}</div>
        </div>
        <span class="r-amt">${money(e.amount)}</span>`;
      ul.appendChild(li);
    });
  }

  /* ================================================================
     EXPORT (local backup of the cache)
     ================================================================ */
  $("exportBtn").addEventListener("click", () => {
    download("store-backup.json", store);
    toast("Backup downloaded (your Google Sheet is the live data)", "⬇");
  });

  function download(name, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /* ---------------- go ---------------- */
  boot();
})();
