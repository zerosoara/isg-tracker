const express = require("express");
const cors    = require("cors");
const fs      = require("fs");
const path    = require("path");
const crypto  = require("crypto");

const app  = express();
const PORT = process.env.PORT || 3000;
const DB   = path.join(__dirname, "db.json");

app.use(cors());
app.use(express.json());

// ── DB helpers ────────────────────────────────────────────────────────────────
function load() {
  if (!fs.existsSync(DB)) return { users: [], orders: [], paychecks: [] };
  try { return JSON.parse(fs.readFileSync(DB, "utf8")); }
  catch { return { users: [], orders: [], paychecks: [] }; }
}
function save(data) { fs.writeFileSync(DB, JSON.stringify(data, null, 2)); }

// ── Auth helpers ──────────────────────────────────────────────────────────────
function hashPassword(pw) {
  return crypto.createHash("sha256").update(pw + "ninjasalt2026").digest("hex");
}
function genToken() {
  return crypto.randomBytes(32).toString("hex");
}
function authMiddleware(req, res, next) {
  const token = req.headers["authorization"]?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "No token" });
  const db   = load();
  const user = db.users.find(u => u.token === token);
  if (!user) return res.status(401).json({ error: "Invalid token" });
  req.user = user;
  next();
}

// ── Commission calc ───────────────────────────────────────────────────────────
const RATES = { newLine1:25, newLineN:15, reactivation:10, homeLine:15 };

function calcCommission(o) {
  const { type, regularLines, homeLines, perAccount, perDevice } = o;
  let t = 0;
  if (type === "reactivation") { t += (regularLines + homeLines) * RATES.reactivation; }
  else {
    if (regularLines >= 1) t += RATES.newLine1;
    if (regularLines >= 2) t += (regularLines - 1) * RATES.newLineN;
    t += homeLines * RATES.homeLine;
  }
  if (perAccount?.aarp)    t += 1;
  if (perAccount?.autopay) t += 1;
  t += (perDevice?.device     || 0) * 1;
  t += (perDevice?.protection || 0) * 1;
  t += (perDevice?.accessories|| 0) * 1;
  t += (perDevice?.irisAlly   || 0) * 10;
  return t;
}

function buildBreakdown(o) {
  const { type, regularLines, homeLines, perAccount, perDevice } = o;
  const items = [];
  if (type === "reactivation") {
    const l = regularLines + homeLines;
    if (l > 0) items.push({ label:`Reactivation (${l}L)`, amt:l*RATES.reactivation, color:"#a78bfa" });
  } else {
    if (regularLines >= 1) items.push({ label:"1st Line",   amt:RATES.newLine1,                         color:"#00e5a0" });
    if (regularLines >= 2) items.push({ label:`+${regularLines-1}L`, amt:(regularLines-1)*RATES.newLineN, color:"#00b8ff" });
    if (homeLines > 0)     items.push({ label:`Home×${homeLines}`,   amt:homeLines*RATES.homeLine,        color:"#fb923c" });
  }
  if (perAccount?.aarp)    items.push({ label:"AARP",    amt:1, color:"#facc15" });
  if (perAccount?.autopay) items.push({ label:"Autopay", amt:1, color:"#facc15" });
  if ((perDevice?.device     ||0)>0) items.push({ label:`Device×${perDevice.device}`,       amt:perDevice.device,      color:"#f472b6" });
  if ((perDevice?.protection ||0)>0) items.push({ label:`Protection×${perDevice.protection}`,amt:perDevice.protection,  color:"#f472b6" });
  if ((perDevice?.accessories||0)>0) items.push({ label:`Accessories×${perDevice.accessories}`,amt:perDevice.accessories,color:"#f472b6" });
  if ((perDevice?.irisAlly   ||0)>0) items.push({ label:`Iris Ally×${perDevice.irisAlly}`,  amt:perDevice.irisAlly*10, color:"#fb923c" });
  return items;
}

// ── Auth routes ───────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status:"ok", service:"Ninja Tracker" }));

app.post("/auth/signup", (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error:"Missing fields" });
  const db = load();
  if (db.users.find(u => u.email.toLowerCase() === email.toLowerCase()))
    return res.status(409).json({ error:"Email already registered" });
  const user = {
    id:        Date.now().toString(),
    email:     email.toLowerCase().trim(),
    name:      name.trim(),
    password:  hashPassword(password),
    token:     genToken(),
    createdAt: new Date().toISOString(),
  };
  db.users.push(user);
  save(db);
  console.log(`[SIGNUP] ${user.email}`);
  res.json({ token:user.token, name:user.name, email:user.email, id:user.id });
});

app.post("/auth/login", (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error:"Missing fields" });
  const db   = load();
  const user = db.users.find(u => u.email === email.toLowerCase().trim());
  if (!user || user.password !== hashPassword(password))
    return res.status(401).json({ error:"Invalid email or password" });
  // Refresh token on login
  user.token = genToken();
  save(db);
  console.log(`[LOGIN] ${user.email}`);
  res.json({ token:user.token, name:user.name, email:user.email, id:user.id });
});

// ── Data routes (all require auth) ───────────────────────────────────────────
app.get("/data", authMiddleware, (req, res) => {
  const db = load();
  const uid = req.user.id;
  res.json({
    orders:    db.orders.filter(o => o.userId === uid),
    paychecks: db.paychecks.filter(p => p.userId === uid),
  });
});

app.post("/orders", authMiddleware, (req, res) => {
  const db  = load();
  const raw = req.body;
  const uid = req.user.id;

  // Support both direct orders and extension-captured orders
  let order;
  if (raw.wirelessLines !== undefined) {
    // From Chrome extension
    const regularLines   = parseInt(raw.wirelessLines)  || 0;
    const homeLines      = parseInt(raw.homePhoneBase)   || 0;
    const isReactivation = raw.reactivation === true || raw.reactivation === "true";
    order = {
      id: Date.now(), userId: uid,
      date:    raw.date || new Date().toISOString().split("T")[0],
      note:    raw.notes || raw.orderId || "",
      orderId: raw.orderId || "",
      type:    isReactivation ? "reactivation" : "new",
      regularLines, homeLines,
      perAccount: {
        aarp:    raw.aarpDiscount === true || raw.aarpDiscount === "true",
        autopay: raw.autoPay     === true || raw.autoPay     === "true",
      },
      perDevice: {
        device:      parseInt(raw.newDevices)      || 0,
        protection:  parseInt(raw.protectionPlans) || 0,
        irisAlly:    parseInt(raw.irisAlly)        || 0,
        accessories: parseInt(raw.accessories)     || 0,
      },
      source: "extension",
    };
  } else {
    // From frontend
    order = { ...raw, id: Date.now(), userId: uid };
  }

  order.commission = calcCommission(order);
  order.breakdown  = buildBreakdown(order);
  db.orders.unshift(order);
  save(db);
  console.log(`[ORDER] ${req.user.email} — $${order.commission}`);
  res.json({ success:true, order });
});

app.put("/orders/:id", authMiddleware, (req, res) => {
  const db  = load();
  const idx = db.orders.findIndex(o => String(o.id) === req.params.id && o.userId === req.user.id);
  if (idx === -1) return res.status(404).json({ error:"Not found" });
  const updated = { ...db.orders[idx], ...req.body, userId:req.user.id };
  updated.commission = calcCommission(updated);
  updated.breakdown  = buildBreakdown(updated);
  db.orders[idx] = updated;
  save(db);
  res.json({ success:true, order:updated });
});

app.delete("/orders/:id", authMiddleware, (req, res) => {
  const db = load();
  db.orders = db.orders.filter(o => !(String(o.id) === req.params.id && o.userId === req.user.id));
  save(db);
  res.json({ success:true });
});

app.post("/paychecks", authMiddleware, (req, res) => {
  const db  = load();
  const uid = req.user.id;
  const { weekStart, amount } = req.body;
  const idx = db.paychecks.findIndex(p => p.weekStart === weekStart && p.userId === uid);
  if (idx >= 0) { db.paychecks[idx].amount = Number(amount); }
  else { db.paychecks.push({ weekStart, amount:Number(amount), userId:uid }); }
  save(db);
  res.json({ success:true });
});

// ── Admin: list all users ─────────────────────────────────────────────────────
app.get("/admin/users", (req, res) => {
  const key = req.headers["x-admin-key"];
  if (key !== "ninja2026admin") return res.status(403).json({ error:"Forbidden" });
  const db = load();
  res.json(db.users.map(u => ({ id:u.id, email:u.email, name:u.name, createdAt:u.createdAt })));
});

// ── Admin: list all orders ────────────────────────────────────────────────────
app.get("/admin/orders", (req, res) => {
  const key = req.headers["x-admin-key"];
  if (key !== "ninja2026admin") return res.status(403).json({ error:"Forbidden" });
  const db = load();
  res.json(db.orders);
});

app.listen(PORT, () => console.log(`Ninja Tracker running on port ${PORT}`));
