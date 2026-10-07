// Minimal vanilla-JS client for the UPI simulator API.
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = { token: localStorageGet("token"), me: null, authMode: "login" };

function localStorageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function localStorageSet(key, value) {
  try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch { /* ignore */ }
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = isError ? "error" : "";
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 3500);
}

async function api(path, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && data.error?.code === "UNAUTHORIZED" && state.token) logout();
    const err = new Error(data.error?.details?.[0]?.message ? `${data.error.message}: ${data.error.details[0].message}` : data.error?.message ?? res.statusText);
    err.code = data.error?.code;
    err.details = data.error?.details;
    throw err;
  }
  return data;
}

function formData(form) {
  const out = {};
  for (const [k, v] of new FormData(form)) if (v !== "") out[k] = v;
  return out;
}

/** Wrap a handler so errors become toasts. */
const safe = (fn) => async (...args) => {
  try { await fn(...args); } catch (e) {
    let msg = e.message;
    if (e.code === "INVALID_PIN" && e.details?.attemptsRemaining !== undefined) msg += ` (${e.details.attemptsRemaining} attempts left)`;
    toast(msg, true);
  }
};

function askPin(title, subtitle = "") {
  const dlg = $("#pin-dialog");
  $("#pin-title").textContent = title;
  $("#pin-subtitle").textContent = subtitle;
  $("#pin-input").value = "";
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.addEventListener("close", () => resolve(dlg.returnValue === "ok" ? $("#pin-input").value : null), { once: true });
  });
}

// ---- Auth ------------------------------------------------------------------

function setAuthMode(mode) {
  state.authMode = mode;
  $$("[data-auth]").forEach((b) => b.classList.toggle("active", b.dataset.auth === mode));
  $$("[data-only]").forEach((el) => (el.hidden = el.dataset.only !== mode));
}

function logout() {
  state.token = null;
  state.me = null;
  localStorageSet("token", null);
  render();
}

$$("[data-auth]").forEach((b) => b.addEventListener("click", () => setAuthMode(b.dataset.auth)));

$("#auth-form").addEventListener("submit", safe(async (e) => {
  e.preventDefault();
  const data = formData(e.target);
  const path = state.authMode === "login" ? "/auth/login" : "/auth/register";
  if (state.authMode === "login") delete data.name;
  const res = await api(path, { method: "POST", body: data });
  state.token = res.token;
  localStorageSet("token", res.token);
  e.target.reset();
  await refresh();
}));

// ---- Navigation ------------------------------------------------------------

function showView(view) {
  $$("[data-view]").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  $$("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== view));
  if (view === "history") loadHistory();
  if (view === "requests") loadRequests();
}
$$("[data-view]").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));

// ---- Rendering -------------------------------------------------------------

async function refresh() {
  if (!state.token) return render();
  try {
    state.me = await api("/me");
  } catch {
    state.me = null;
    return render();
  }
  render();
  loadRequests();
}

function render() {
  const loggedIn = Boolean(state.me);
  $("#auth-view").hidden = loggedIn;
  $("#app-view").hidden = !loggedIn;
  if (!loggedIn) {
    $("#whoami").innerHTML = "";
    setAuthMode(state.authMode);
    return;
  }
  const { user, accounts, vpas } = state.me;
  $("#whoami").innerHTML = `<span>${esc(user.name)}</span><button class="small" id="logout">Log out</button>`;
  $("#logout").onclick = logout;

  $("#accounts").innerHTML = accounts.length
    ? accounts.map((a) => `
      <li>
        <div><strong>${esc(a.bank.name)}</strong><p class="muted">${esc(a.maskedAccountNumber)} · ${esc(a.ifsc)}</p></div>
        <div class="row">
          <button class="small" data-pin="${a.id}">${a.pinSet ? "Change PIN" : "Set UPI PIN"}</button>
          ${a.pinSet ? `<button class="small" data-balance="${a.id}">Balance</button>` : ""}
        </div>
      </li>`).join("")
    : `<li class="empty">No bank accounts linked yet</li>`;

  $("#vpas").innerHTML = vpas.length
    ? vpas.map((v) => {
        const a = accounts.find((x) => x.id === v.accountId);
        return `<li><strong>${esc(v.address)}</strong><span class="muted">${esc(a?.bank.name)} ${esc(a?.maskedAccountNumber.slice(-4))}</span></li>`;
      }).join("")
    : `<li class="empty">Create a UPI ID to send and receive money</li>`;

  $("#vpa-account-select").innerHTML = accounts
    .map((a) => `<option value="${a.id}">${esc(a.bank.code)} ${esc(a.maskedAccountNumber.slice(-4))}</option>`).join("");
  $$(".my-vpas").forEach((s) => (s.innerHTML = vpas.map((v) => `<option>${esc(v.address)}</option>`).join("")));
}

$("#accounts").addEventListener("click", safe(async (e) => {
  const pinId = e.target.dataset.pin;
  const balId = e.target.dataset.balance;
  if (pinId) {
    const account = state.me.accounts.find((a) => a.id === Number(pinId));
    let oldPin;
    if (account.pinSet) {
      oldPin = await askPin("Current UPI PIN");
      if (oldPin === null) return;
    }
    const pin = await askPin("New UPI PIN", "4 or 6 digits");
    if (pin === null) return;
    await api(`/accounts/${pinId}/pin`, { method: "POST", body: { pin, oldPin } });
    toast("UPI PIN set");
    await refresh();
  } else if (balId) {
    const pin = await askPin("Check balance");
    if (pin === null) return;
    const res = await api(`/accounts/${balId}/balance`, { method: "POST", body: { pin } });
    toast(`Available balance: ₹${res.balance}`);
  }
}));

async function loadBanks() {
  const banks = await api("/banks");
  $("#bank-select").innerHTML = banks.map((b) => `<option value="${esc(b.code)}">${esc(b.name)} (@${esc(b.vpaHandle)})</option>`).join("");
}

$("#link-form").addEventListener("submit", safe(async (e) => {
  e.preventDefault();
  await api("/accounts", { method: "POST", body: formData(e.target) });
  toast("Bank account linked");
  await refresh();
}));

$("#vpa-form").addEventListener("submit", safe(async (e) => {
  e.preventDefault();
  const data = formData(e.target);
  const vpa = await api("/vpas", { method: "POST", body: { username: data.username, accountId: Number(data.accountId) } });
  toast(`Created ${vpa.address}`);
  e.target.reset();
  await refresh();
}));

// ---- Send ------------------------------------------------------------------

let resolveTimer;
$("#pay-form [name=toVpa]").addEventListener("input", (e) => {
  clearTimeout(resolveTimer);
  const out = $("#payee-name");
  out.textContent = "";
  const v = e.target.value.trim();
  if (!v.includes("@")) return;
  resolveTimer = setTimeout(async () => {
    try {
      const r = await api(`/vpas/${encodeURIComponent(v)}/resolve`);
      out.textContent = `Paying ${r.name}`;
    } catch {
      out.textContent = "UPI ID not found";
    }
  }, 350);
});

async function doPay(body) {
  const pin = await askPin(`Pay ₹${body.amount}`, `to ${body.toVpa}`);
  if (pin === null) return;
  const txn = await api("/payments", {
    method: "POST",
    body: { ...body, pin },
    headers: { "Idempotency-Key": crypto.randomUUID() },
  });
  if (txn.status === "SUCCESS") toast(`Paid ₹${txn.amount} · Ref ${txn.id}`);
  else toast(`Payment failed: ${txn.failure?.message ?? txn.status} · Ref ${txn.id}`, true);
  return txn;
}

$("#pay-form").addEventListener("submit", safe(async (e) => {
  e.preventDefault();
  const txn = await doPay(formData(e.target));
  if (txn?.status === "SUCCESS") {
    e.target.reset();
    $("#payee-name").textContent = "";
    render();
  }
}));

$("#scan-form").addEventListener("submit", safe(async (e) => {
  e.preventDefault();
  const link = await api("/qr/parse", { method: "POST", body: formData(e.target) });
  const form = $("#pay-form");
  form.toVpa.value = link.pa;
  form.amount.value = link.amountPaise !== undefined ? (link.amountPaise / 100).toFixed(2) : "";
  form.note.value = link.tn ?? "";
  $("#payee-name").textContent = `Paying ${link.payee.name}`;
  form.amount.focus();
  toast("Payment details filled in");
}));

// ---- Receive ---------------------------------------------------------------

$("#qr-form").addEventListener("submit", safe(async (e) => {
  e.preventDefault();
  const { vpa, ...q } = formData(e.target);
  const qs = new URLSearchParams(q).toString();
  const res = await api(`/vpas/${encodeURIComponent(vpa)}/qr${qs ? `?${qs}` : ""}`);
  $("#qr-out").innerHTML = `<img src="${esc(res.qrDataUrl)}" alt="UPI QR code" /><code>${esc(res.uri)}</code>`;
}));

$("#collect-form").addEventListener("submit", safe(async (e) => {
  e.preventDefault();
  const c = await api("/collect", { method: "POST", body: formData(e.target) });
  toast(`Requested ₹${c.amount} from ${c.payerVpa}`);
  e.target.reset();
  render();
}));

// ---- Requests --------------------------------------------------------------

function collectItem(c, incoming) {
  const who = incoming ? `${esc(c.payeeVpa)} requests` : `Requested from ${esc(c.payerVpa)}`;
  const actions = incoming && c.status === "PENDING"
    ? `<div class="row"><button class="small" data-decline="${c.id}">Decline</button><button class="small primary" data-approve="${c.id}">Pay</button></div>`
    : `<span class="status ${c.status}">${c.status}</span>`;
  return `<li>
    <div><strong>${who}</strong><p class="muted">${esc(c.note ?? "")} · expires ${new Date(c.expiresAt).toLocaleString()}</p></div>
    <div class="row"><span class="amt">₹${esc(c.amount)}</span>${actions}</div>
  </li>`;
}

async function loadRequests() {
  if (!state.token) return;
  const [incoming, outgoing] = await Promise.all([api("/collect/incoming"), api("/collect/outgoing")]).catch(() => [[], []]);
  $("#incoming").innerHTML = incoming.length ? incoming.map((c) => collectItem(c, true)).join("") : `<li class="empty">Nothing to pay</li>`;
  $("#outgoing").innerHTML = outgoing.length ? outgoing.map((c) => collectItem(c, false)).join("") : `<li class="empty">No requests sent</li>`;
  const pending = incoming.filter((c) => c.status === "PENDING").length;
  $("#req-badge").hidden = pending === 0;
  $("#req-badge").textContent = pending;
}

$("#incoming").addEventListener("click", safe(async (e) => {
  const { approve, decline } = e.target.dataset;
  if (approve) {
    const pin = await askPin("Approve request");
    if (pin === null) return;
    const { transaction: t } = await api(`/collect/${approve}/approve`, { method: "POST", body: { pin } });
    if (t.status === "SUCCESS") toast(`Paid ₹${t.amount} · Ref ${t.id}`);
    else toast(`Payment failed: ${t.failure?.message} · Ref ${t.id}`, true);
  } else if (decline) {
    await api(`/collect/${decline}/decline`, { method: "POST" });
    toast("Request declined");
  } else return;
  loadRequests();
}));

// ---- History ---------------------------------------------------------------

async function loadHistory() {
  const txns = await api("/transactions?limit=50").catch(() => []);
  $("#history").innerHTML = txns.length
    ? txns.map((t) => {
        const counterpart = t.direction === "CREDIT" ? `From ${t.payerVpa}` : `To ${t.payeeVpa}`;
        const sign = t.direction === "CREDIT" ? "+" : t.direction === "DEBIT" ? "−" : "";
        return `<li>
          <div><strong>${esc(counterpart)}</strong>
            <p class="muted">${esc(t.note ?? "")}${t.note ? " · " : ""}${new Date(t.createdAt).toLocaleString()} · Ref ${esc(t.id)}${t.failure ? ` · ${esc(t.failure.message)}` : ""}</p></div>
          <div style="text-align:right"><span class="amt ${t.direction === "CREDIT" ? "credit" : ""}">${sign}₹${esc(t.amount)}</span><br/>
            <span class="status ${t.status}">${t.status}</span></div>
        </li>`;
      }).join("")
    : `<li class="empty">No transactions yet</li>`;
}

// ---- Boot ------------------------------------------------------------------

loadBanks().catch(() => {});
refresh();
