// Ninja Tracker - ISG Order Sync (Angular Material aware)
// Silent. Captures the sale you submit on the ISG portal and sends it to your tracker.
// Field map confirmed from the live form (cci.infsalesgroup.com):
//   text inputs: agentId, ani, orderId (= account/order #), orderAni, accessories, notes
//   mat-select dropdowns (read BY LABEL, no formcontrolname): Wireless Lines, Protection Plans,
//   New Devices, IRIS Ally/PERS, Tablet w/ Line, Watch w/ Line, Home Phone Base

const BACKEND_URL = "https://isg-tracker.onrender.com";

function getToken() {
  return new Promise(resolve => {
    chrome.storage.local.get("nt_token", data => resolve(data.nt_token || null));
  });
}

const norm = s => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// read the value of one mat-form-field: input/textarea value, native select, or the mat-select's shown text
function fieldVal(mf) {
  const input = mf.querySelector("input, textarea");
  if (input && input.value != null && input.value !== "") return input.value.trim();
  const sel = mf.querySelector("select");
  if (sel && sel.value) return sel.value;
  const ms = mf.querySelector(".mat-mdc-select-value-text, .mat-mdc-select-value");
  if (ms && ms.innerText) return ms.innerText.trim();
  return input ? (input.value || "").trim() : "";
}

// Build a lookup of every form field, keyed by BOTH its formcontrolname and its label text.
function captureAll() {
  const map = {};
  document.querySelectorAll("mat-form-field").forEach(mf => {
    const lab = (mf.querySelector("mat-label") && mf.querySelector("mat-label").innerText || "").trim();
    const fcEl = mf.querySelector("[formcontrolname]");
    const fcn = fcEl ? fcEl.getAttribute("formcontrolname") : "";
    const val = fieldVal(mf);
    if (lab) map["lbl:" + norm(lab)] = val;
    if (fcn) map[fcn] = val;
  });
  // also catch any plain inputs not wrapped in mat-form-field
  document.querySelectorAll("input[formcontrolname], textarea[formcontrolname], select[formcontrolname]").forEach(e => {
    map[e.getAttribute("formcontrolname")] = (e.value || "").trim();
  });
  return map;
}

// toggles (Auto Pay / AARP / Reactivation) — mat-slide-toggle or checkbox, matched by nearby text
function captureToggles() {
  const res = { autoPay: false, aarpDiscount: false, reactivation: false };
  document.querySelectorAll("mat-slide-toggle, mat-checkbox, [role='switch'], input[type='checkbox']").forEach(t => {
    const txt = norm(
      (t.closest("mat-slide-toggle") && t.closest("mat-slide-toggle").innerText) ||
      (t.closest("mat-checkbox") && t.closest("mat-checkbox").innerText) ||
      t.getAttribute("aria-label") ||
      (t.closest("label") && t.closest("label").innerText) ||
      (t.parentElement && t.parentElement.innerText) || ""
    );
    const sw = t.matches("[role='switch']") ? t : t.querySelector("[role='switch']");
    let on = false;
    if (sw) on = sw.getAttribute("aria-checked") === "true";
    else if (t.matches("input[type='checkbox']")) on = t.checked;
    else { const i = t.querySelector("input[type='checkbox']"); if (i) on = i.checked; }
    if (/autopay|ach/.test(txt)) res.autoPay = on;
    if (/aarp/.test(txt)) res.aarpDiscount = on;
    if (/reactivat/.test(txt)) res.reactivation = on;
  });
  return res;
}

async function captureForm() {
  const token = await getToken();
  if (!token) return; // not logged into the tracker yet

  const m = captureAll();
  const tg = captureToggles();
  const byName = (...keys) => { for (const k of keys) { if (m[k] != null && m[k] !== "") return m[k]; } return ""; };
  const byLabel = (...labels) => { for (const l of labels) { const v = m["lbl:" + norm(l)]; if (v != null && v !== "") return v; } return ""; };
  const num = v => { const n = parseInt(String(v).replace(/[^0-9]/g, "")); return isNaN(n) ? "0" : String(n); };

  const orderId = byName("orderId") || byLabel("Order ID");

  const payload = {
    date:            new Date().toISOString().split("T")[0],
    agentId:         byName("agentId") || byLabel("Agent ID"),
    ani:             byName("ani", "orderAni") || byLabel("Call ANI", "Order ANI"),
    orderId:         orderId,
    accountNumber:   orderId,   // this form's unique identifier (no separate "account #" field exists)
    wirelessLines:   num(byLabel("Wireless Lines")),
    protectionPlans: num(byLabel("Protection Plans")),
    newDevices:      num(byLabel("New Devices")),
    irisAlly:        num(byLabel("IRIS Ally/PERS", "IRIS Ally", "IRIS Ally / PERS", "PERS")),
    tabletWithLine:  num(byLabel("Tablet w/ Line", "Tablet with Line", "Tablet")),
    watchWithLine:   num(byLabel("Watch w/ Line", "Watch with Line", "Watch")),
    homePhoneBase:   num(byLabel("Home Phone Base", "Home Phone")),
    accessories:     num(byName("accessories") || byLabel("Accessories")),
    notes:           byName("notes") || byLabel("Notes"),
    autoPay:         tg.autoPay,
    aarpDiscount:    tg.aarpDiscount,
    reactivation:    tg.reactivation,
    rawFields:       Object.assign({}, m, { _toggles: tg }),  // full capture for verification
  };

  // don't send an empty/non-order capture
  const anyLines = (parseInt(payload.wirelessLines) || 0) + (parseInt(payload.homePhoneBase) || 0);
  if (!payload.orderId && anyLines === 0 && Object.keys(m).length === 0) return;

  fetch(`${BACKEND_URL}/orders`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body:    JSON.stringify(payload),
  }).catch(() => {});
}

// fire on the "Submit Sale" button (confirmed: <button type="submit"> ... "Submit Sale")
function attachListener() {
  const tryAttach = () => {
    document.querySelectorAll("button").forEach(btn => {
      if (btn.dataset.ntAttached) return;
      const t = (btn.textContent || "").trim().toLowerCase();
      if (btn.type === "submit" || /submit/.test(t)) {
        btn.dataset.ntAttached = "true";
        btn.addEventListener("click", () => setTimeout(captureForm, 500), { capture: true });
      }
    });
  };
  tryAttach();
  new MutationObserver(tryAttach).observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", attachListener);
} else {
  attachListener();
}
