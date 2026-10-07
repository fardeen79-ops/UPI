// Minimal vanilla-JS client for the UAE instant payments simulator API.
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = { token: storageGet("token"), me: null, authMode: "login" };

function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function storageSet(key, value) {
  try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch { /* ignore */ }
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
const aed = (s) => `AED ${Number(s).toLocaleString("en-AE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

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
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && data.error?.code === "UNAUTHORIZED" && state.token) logout();
    const detail = data.error?.details?.[0]?.message;
    const err = new Error(detail ? `${data.error.message}: ${detail}` : data.error?.message ?? res.statusText);
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

const safe = (fn) => async (...args) => {
  try { await fn(...args); } catch (e) {
    let msg = e.message;
    if (e.code === "INVALID_PASSCODE" && e.details?.attemptsRemaining !== undefined) msg += ` (${e.details.attemptsRemaining} attempts left)`;
    toast(msg, true);
  }
};

function askPasscode(title, subtitle = "") {
  const dlg = $("#pin-dialog");
  $("#pin-title").textContent = title;
  $("#pin-subtitle").textContent = subtitle;
  $("#pin-input").value = "";
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.addEventListener("close", () => resolve(dlg.returnValue === "ok" ? $("#pin-input").value : null), { once: true });
  });
}

function txnToast(t) {
  if (t.status === "SUCCESS") toast(`Sent ${aed(t.amount)} to ${t.counterparty.name} · Ref ${t.id}`);
  else toast(`Payment failed: ${t.failure?.message ?? t.status} · Ref ${t.id}`, true);
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
  storageSet("token", null);
  render();
}

$$("[data-auth]").forEach((b) => b.addEventListener("click", () => setAuthMode(b.dataset.auth)));

$("#auth-form").addEventListener("submit", safe(async (e) => {
  e.preventDefault();
  const data = formData(e.target);
  if (state.authMode === "login") { delete data.name; delete data.emiratesId; }
  const res = await api(state.authMode === "login" ? "/auth/login" : "/auth/register", { method: "POST", body: data });
  state.token = res.token;
  storageSet("token", res.token);
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

// ---- Home ------------------------------------------------------------------

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
  const { user, accounts, proxies } = state.me;
  $("#whoami").innerHTML = `<span>${esc(user.name)}</span><button class="small" id="logout">Log out</button>`;
  $("#logout").onclick = logout;
  $("#passcode-card").hidden = user.passcodeSet;

  $("#accounts").innerHTML = accounts.length
    ? accounts.map((a) => `
      <li>
        <div><strong>${esc(a.bank.name)}</strong>
          <p class="muted mono">${esc(a.iban)}</p>
          <p>${a.proxies.map((p) => `<span class="chip">${esc(p.value)}</span>`).join("")}</p></div>
        <span class="amt">${aed(a.balance)}</span>
      </li>`).join("")
    : `<li class="empty">Open an account to start sending and receiving</li>`;

  const acctLabel = (id) => {
    const a = accounts.find((x) => x.id === id);
    return a ? `${a.bank.name} ··${a.iban.replace(/\s/g, "").slice(-4)}` : "";
  };
  $("#proxies").innerHTML = proxies.length
    ? proxies.map((p) => `
      <li>
        <div><span class="chip">${p.type === "MOBILE" ? "Mobile" : "Email"}</span><strong>${esc(p.value)}</strong>
          <p class="muted">→ ${esc(acctLabel(p.accountId))}</p></div>
        ${accounts.length > 1 ? `<select class="small" data-repoint="${esc(p.type)}|${esc(p.value)}">
            ${accounts.map((a) => `<option value="${a.id}" ${a.id === p.accountId ? "selected" : ""}>${esc(acctLabel(a.id))}</option>`).join("")}
          </select>` : ""}
      </li>`).join("")
    : `<li class="empty">Your mobile number is registered when you open your first account</li>`;

  $$(".my-accounts").forEach((s) => {
    const prev = s.value;
    s.innerHTML = accounts.map((a) => `<option value="${a.id}">${esc(acctLabel(a.id))} · ${aed(a.balance)}</option>`).join("");
    if (prev) s.value = prev;
  });
}

async function setPasscodeFlow(change) {
  let oldPasscode;
  if (change) {
    oldPasscode = await askPasscode("Current passcode");
    if (oldPasscode === null) return;
  }
  const passcode = await askPasscode("New passcode", "6 digits");
  if (passcode === null) return;
  await api("/me/passcode", { method: "POST", body: { passcode, oldPasscode } });
  toast("Passcode saved");
  await refresh();
}
$("#set-passcode").addEventListener("click", safe(() => setPasscodeFlow(false)));
$("#change-passcode").addEventListener("click", safe(() => setPasscodeFlow(state.me.user.passcodeSet)));

async function loadBanks() {
  const banks = await api("/banks");
  $("#bank-select").innerHTML = banks.map((b) => `<option value="${esc(b.code)}">${esc(b.name)}</option>`).join("");
}

$("#open-form").addEventListener("submit", safe(async (e) => {
  e.preventDefault();
  await api("/accounts", { method: "POST", body: formData(e.target) });
  toast("Account opened");
  await refresh();
}));

$("#proxy-form").addEventListener("submit", safe(async (e) => {
  e.preventDefault();
  const d = formData(e.target);
  await api("/proxies", { method: "PUT", body: { type: "EMAIL", value: d.value, accountId: Number(d.accountId) } });
  toast(`You can now be paid at ${d.value}`);
  e.target.reset();
  await refresh();
}));

$("#proxies").addEventListener("change", safe(async (e) => {
  const key = e.target.dataset.repoint;
  if (!key) return;
  const [type, value] = key.split("|");
  await api("/proxies", { method: "PUT", body: { type, value, accountId: Number(e.target.value) } });
  toast(`${value} now receives into the selected account`);
  await refresh();
}));

// ---- Send ------------------------------------------------------------------

let lookupTimer;
$("#send-form [name=to]").addEventListener("input", (e) => {
  clearTimeout(lookupTimer);
  const out = $("#recipient-info");
  out.textContent = "";
  const to = e.target.value.trim();
  if (to.length < 9) return;
  lookupTimer = setTimeout(async () => {
    try {
      const r = await api("/lookup", { method: "POST", body: { to } });
      out.textContent = `Sending to ${r.name} · ${r.bank} · ${r.iban}`;
    } catch (err) {
      out.textContent = err.code === "RECIPIENT_NOT_FOUND" ? "No account is registered for this recipient" : "";
    }
  }, 350);
});

$("#send-form").addEventListener("submit", safe(async (e) => {
  e.preventDefault();
  const d = formData(e.target);
  const passcode = await askPasscode(`Send ${aed(d.amount)}`, `to ${d.to}`);
  if (passcode === null) return;
  const t = await api("/transfers", {
    method: "POST",
    body: { ...d, fromAccountId: Number(d.fromAccountId), passcode },
    headers: { "Idempotency-Key": crypto.randomUUID() },
  });
  txnToast(t);
  if (t.status === "SUCCESS") {
    e.target.reset();
    $("#recipient-info").textContent = "";
  }
  await refresh();
}));

$("#scan-form").addEventListener("submit", safe(async (e) => {
  e.preventDefault();
  const qr = await api("/qr/parse", { method: "POST", body: formData(e.target) });
  const form = $("#send-form");
  form.to.value = qr.to;
  form.amount.value = qr.amountFils !== undefined ? (qr.amountFils / 100).toFixed(2) : "";
  form.note.value = qr.note ?? qr.reference ?? "";
  $("#recipient-info").textContent = `Sending to ${qr.recipient.name} · ${qr.recipient.bank} · ${qr.recipient.iban}`;
  form.amount.focus();
  toast("Payment details filled in from QR");
}));

// ---- Receive ---------------------------------------------------------------

$("#qr-form").addEventListener("submit", safe(async (e) => {
  e.preventDefault();
  const qs = new URLSearchParams(formData(e.target)).toString();
  const res = await api(`/qr?${qs}`);
  $("#qr-out").innerHTML = `<img src="${esc(res.qrDataUrl)}" alt="Payment QR code" /><code>${esc(res.payload)}</code>`;
}));

$("#request-form").addEventListener("submit", safe(async (e) => {
  e.preventDefault();
  const d = formData(e.target);
  const r = await api("/requests", { method: "POST", body: { ...d, toAccountId: Number(d.toAccountId) } });
  toast(`Requested ${aed(r.amount)} from ${r.payer.name}`);
  e.target.reset();
  render();
}));

function addPerson() {
  const row = document.createElement("div");
  row.className = "split-row";
  row.innerHTML = `<input name="who" placeholder="050 123 4567 or email" /><button type="button" class="small" aria-label="Remove">✕</button>`;
  row.querySelector("button").onclick = () => { row.remove(); previewSplit(); };
  row.querySelector("input").oninput = previewSplit;
  $("#split-people").append(row);
}
function previewSplit() {
  const form = $("#split-form");
  const people = $$("#split-people [name=who]").filter((i) => i.value.trim()).length;
  const total = Number(form.total.value);
  const n = people + (form.includeSelf.checked ? 1 : 0);
  $("#split-preview").textContent = people && total > 0 ? `≈ ${aed(Math.floor((total * 100) / n) / 100)} each` : "";
}
$("#add-person").addEventListener("click", addPerson);
$("#split-form").addEventListener("input", previewSplit);
addPerson();
addPerson();

$("#split-form").addEventListener("submit", safe(async (e) => {
  e.preventDefault();
  const form = e.target;
  const participants = $$("#split-people [name=who]").map((i) => i.value.trim()).filter(Boolean).map((who) => ({ who }));
  const split = await api("/splits", {
    method: "POST",
    body: { total: form.total.value, note: form.note.value || undefined, includeSelf: form.includeSelf.checked, participants },
  });
  toast(`Split sent to ${split.requests.length} people`);
  form.reset();
  $("#split-people").innerHTML = "";
  addPerson();
  addPerson();
  previewSplit();
}));

// ---- Requests --------------------------------------------------------------

function requestItem(r, incoming) {
  const who = incoming ? `${esc(r.requester.name)} requests` : `Requested from ${esc(r.payer.name)}`;
  let actions = `<span class="status ${r.status}">${r.status}</span>`;
  if (r.status === "PENDING") {
    actions = incoming
      ? `<button class="small" data-decline="${r.id}">Decline</button><button class="small primary" data-pay="${r.id}" data-amount="${esc(r.amount)}">Pay</button>`
      : `<button class="small" data-cancel="${r.id}">Cancel</button>`;
  }
  return `<li>
    <div><strong>${who}</strong><p class="muted">${esc(r.note ?? "")}${r.splitId ? " · split" : ""} · expires ${new Date(r.expiresAt).toLocaleString()}</p></div>
    <div class="row"><span class="amt">${aed(r.amount)}</span>${actions}</div>
  </li>`;
}

async function loadRequests() {
  if (!state.token) return;
  const [incoming, outgoing, splits] = await Promise.all([
    api("/requests/incoming"), api("/requests/outgoing"), api("/splits"),
  ]).catch(() => [[], [], []]);
  $("#incoming").innerHTML = incoming.length ? incoming.map((r) => requestItem(r, true)).join("") : `<li class="empty">Nothing to pay</li>`;
  $("#outgoing").innerHTML = outgoing.filter((r) => !r.splitId).map((r) => requestItem(r, false)).join("") || `<li class="empty">No requests sent</li>`;
  $("#splits").innerHTML = splits.length
    ? splits.map((s) => `<li style="display:block">
        <div class="row" style="justify-content:space-between"><strong>${esc(s.note ?? "Split bill")}</strong>
          <span class="muted">${aed(s.collected)} of ${aed(s.total)} collected</span></div>
        <div class="progress"><div style="width:${Math.min(100, (s.collectedFils / s.totalFils) * 100)}%"></div></div>
        <details><summary class="muted">${s.requests.length} people</summary>
          <ul class="list">${s.requests.map((r) => `<li><span>${esc(r.payer.name)} <span class="muted">${esc(r.payer.label)}</span></span>
            <span class="row"><span class="amt">${aed(r.amount)}</span><span class="status ${r.status}">${r.status}</span></span></li>`).join("")}</ul>
        </details></li>`).join("")
    : `<li class="empty">No split bills yet</li>`;
  const pending = incoming.filter((r) => r.status === "PENDING").length;
  $("#req-badge").hidden = pending === 0;
  $("#req-badge").textContent = pending;
}

document.querySelector("[data-panel=requests]").addEventListener("click", safe(async (e) => {
  const { pay, decline, cancel, amount } = e.target.dataset;
  if (pay) {
    const passcode = await askPasscode(`Pay ${aed(amount)}`);
    if (passcode === null) return;
    const { transaction } = await api(`/requests/${pay}/pay`, { method: "POST", body: { passcode } });
    txnToast(transaction);
    await refresh();
  } else if (decline) {
    await api(`/requests/${decline}/decline`, { method: "POST" });
    toast("Request declined");
  } else if (cancel) {
    await api(`/requests/${cancel}/cancel`, { method: "POST" });
    toast("Request cancelled");
  } else return;
  loadRequests();
}));

// ---- History ---------------------------------------------------------------

async function loadHistory() {
  const txns = await api("/transactions?limit=50").catch(() => []);
  $("#history").innerHTML = txns.length
    ? txns.map((t) => {
        const verb = t.direction === "CREDIT" ? "From" : t.direction === "SELF" ? "Own account" : "To";
        const sign = t.direction === "CREDIT" ? "+" : t.direction === "DEBIT" ? "−" : "";
        return `<li>
          <div><strong>${esc(verb)} ${esc(t.counterparty.name)}</strong>
            <p class="muted">${esc(t.counterparty.label)}${t.note ? ` · ${esc(t.note)}` : ""} · ${new Date(t.createdAt).toLocaleString()}</p>
            <p class="muted mono">${esc(t.id)}${t.failure ? ` · ${esc(t.failure.message)}` : ""}</p></div>
          <div style="text-align:right"><span class="amt ${t.direction === "CREDIT" ? "credit" : ""}">${sign}${aed(t.amount)}</span><br/>
            <span class="status ${t.status}">${t.status}</span></div>
        </li>`;
      }).join("")
    : `<li class="empty">No transactions yet</li>`;
}

loadBanks().catch(() => {});
refresh();
