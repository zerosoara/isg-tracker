const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "orders.json");

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── Helpers ───────────────────────────────────────────────────────────────────
function loadData() {
  if (!fs.existsSync(DATA_FILE)) return { orders: [], paychecks: [] };
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch { return { orders: [], paychecks: [] }; }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ── Commission calc (mirrors frontend logic) ──────────────────────────────────
const RATES = {
  newLine1: 25, newLineN: 15, reactivation: 10, homeLine: 15,
};

function calcCommission(order) {
  const { type, regularLines, homeLines, perAccount, perDevice } = order;
  let total = 0;
  if (type === "reactivation") {
    total += (regularLines + homeLines) * RATES.reactivation;
  } else {
    if (regularLines >= 1) total += RATES.newLine1;
    if (regularLines >= 2) total += (regularLines - 1) * RATES.newLineN;
    total += homeLines * RATES.homeLine;
  }
  if (perAccount.aarp)    total += 1;
  if (perAccount.autopay) total += 1;
  total += (perDevice.device || 0) * 1;
  total += (perDevice.protection || 0) * 1;
  return total;
}

function buildBreakdown(order) {
  const { type, regularLines, homeLines, perAccount, perDevice } = order;
  const items = [];
  if (type === "reactivation") {
    const l = regularLines + homeLines;
    if (l > 0) items.push({ label: `Reactivation (${l} line${l > 1 ? "s" : ""})`, amt: l * RATES.reactivation, color: "#a78bfa" });
  } else {
    if (regularLines >= 1) items.push({ label: "1st Line", amt: RATES.newLine1, color: "#00e5a0" });
    if (regularLines >= 2) items.push({ label: `+${regularLines - 1} Line${regularLines - 1 > 1 ? "s" : ""}`, amt: (regularLines - 1) * RATES.newLineN, color: "#00b8ff" });
    if (homeLines > 0)     items.push({ label: `Home Phone${homeLines > 1 ? " ×" + homeLines : ""}`, amt: homeLines * RATES.homeLine, color: "#fb923c" });
  }
  if (perAccount.aarp)    items.push({ label: "AARP",    amt: 1, color: "#facc15" });
  if (perAccount.autopay) items.push({ label: "Autopay", amt: 1, color: "#facc15" });
  if ((perDevice.device || 0) > 0)     items.push({ label: `New Device${perDevice.device > 1 ? " ×" + perDevice.device : ""}`,     amt: perDevice.device,     color: "#f472b6" });
  if ((perDevice.protection || 0) > 0) items.push({ label: `Protection${perDevice.protection > 1 ? " ×" + perDevice.protection : ""}`, amt: perDevice.protection, color: "#f472b6" });
  return items;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Health check
app.get("/", (req, res) => res.json({ status: "ok", service: "ISG Pay Tracker" }));

// GET all data
app.get("/data", (req, res) => {
  res.json(loadData());
});

// POST new order (from Chrome extension)
app.post("/orders", (req, res) => {
  const data = loadData();
  const raw = req.body;

  // Map ISG portal fields → tracker format
  const regularLines = parseInt(raw.wirelessLines) || 0;
  const homeLines    = parseInt(raw.homePhoneBase)  || 0;
  const isReactivation = raw.reactivation === true || raw.reactivation === "true";

  const order = {
    id:           Date.now(),
    date:         raw.date || new Date().toISOString().split("T")[0],
    note:         raw.notes || raw.orderId || "",
    orderId:      raw.orderId || "",
    type:         isReactivation ? "reactivation" : "new",
    regularLines,
    homeLines,
    perAccount: {
      aarp:    raw.aarpDiscount === true || raw.aarpDiscount === "true",
      autopay: raw.autoPay     === true || raw.autoPay     === "true",
    },
    perDevice: {
      device:     parseInt(raw.newDevices)     || 0,
      protection: parseInt(raw.protectionPlans) || 0,
    },
    // Extra ISG fields stored for reference
    irisAlly:       parseInt(raw.irisAlly)       || 0,
    tabletWithLine: parseInt(raw.tabletWithLine) || 0,
    watchWithLine:  parseInt(raw.watchWithLine)  || 0,
    accessories:    parseInt(raw.accessories)    || 0,
    source: "extension",
  };

  order.commission = calcCommission(order);
  order.breakdown  = buildBreakdown(order);

  data.orders.unshift(order);
  saveData(data);

  console.log(`[${new Date().toISOString()}] Order logged: $${order.commission} (${order.type}, ${regularLines + homeLines} lines)`);
  res.json({ success: true, order });
});

// DELETE order
app.delete("/orders/:id", (req, res) => {
  const data = loadData();
  data.orders = data.orders.filter(o => String(o.id) !== req.params.id);
  saveData(data);
  res.json({ success: true });
});

// PUT update order
app.put("/orders/:id", (req, res) => {
  const data = loadData();
  const idx = data.orders.findIndex(o => String(o.id) === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });
  const updated = { ...data.orders[idx], ...req.body };
  updated.commission = calcCommission(updated);
  updated.breakdown  = buildBreakdown(updated);
  data.orders[idx] = updated;
  saveData(data);
  res.json({ success: true, order: updated });
});

// POST paycheck
app.post("/paychecks", (req, res) => {
  const data = loadData();
  const { weekStart, amount } = req.body;
  const existing = data.paychecks.findIndex(p => p.weekStart === weekStart);
  if (existing >= 0) {
    data.paychecks[existing].amount = Number(amount);
  } else {
    data.paychecks.push({ weekStart, amount: Number(amount) });
  }
  saveData(data);
  res.json({ success: true });
});

app.listen(PORT, () => console.log(`ISG Pay Tracker backend running on port ${PORT}`));
