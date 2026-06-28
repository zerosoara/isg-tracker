const express  = require("express");
const cors     = require("cors");
const crypto   = require("crypto");
const mongoose = require("mongoose");

const app  = express();
const PORT = process.env.PORT || 3000;

// Connection string comes ONLY from the environment. No credentials in code.
const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error("FATAL: MONGO_URI environment variable is not set. Set it in the Render dashboard.");
  process.exit(1);
}

app.use(cors());
app.use(express.json());

// ── Connect to MongoDB ────────────────────────────────────────────────────────
mongoose.connect(MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch(e => console.error("MongoDB error:", e));

// ── Schemas ───────────────────────────────────────────────────────────────────
const UserSchema = new mongoose.Schema({
  email:     { type: String, required: true, unique: true, lowercase: true, trim: true },
  name:      { type: String, required: true, trim: true },
  password:  String,
  token:     String,            // legacy single-token field (kept for backward compatibility)
  tokens:    { type: [String], default: [] },  // one token per logged-in device
  settings:  {                  // per-user prefs that sync across devices
    weekGoal:       { type: Number, default: 0 },
    monthGoal:      { type: Number, default: 0 },
    hourlySchedule: { type: String, default: "A" },
    taxRate:        { type: Number, default: 25 },
    theme:          { type: String, default: "ninja" },
    // attendance: { "YYYY-MM-DD": hoursWorked }  — off day = 0, late = fewer hours
    attendance:     { type: mongoose.Schema.Types.Mixed, default: {} },
    // customPresets: [{ name, cfg:{...order config} }]
    customPresets:  { type: mongoose.Schema.Types.Mixed, default: [] },
  },
  createdAt: { type: Date, default: Date.now },
});

// Keep at most this many active device tokens per user (oldest dropped first).
const MAX_TOKENS = 10;
// Add a fresh token for a new device WITHOUT invalidating existing devices.
function addToken(user) {
  const t = genToken();
  user.tokens = (user.tokens || []).concat(t).slice(-MAX_TOKENS);
  user.token  = t;             // keep legacy field populated too
  return t;
}

const OrderSchema = new mongoose.Schema({
  userId:       { type: String, required: true },
  date:         String,
  note:         String,
  orderId:      String,
  accountNumber:String,        // customer account # (for pay disputes / lookups)
  type:         { type: String, default: "new" },
  regularLines: { type: Number, default: 0 },
  homeLines:    { type: Number, default: 0 },
  perAccount:   { aarp: Boolean, autopay: Boolean },
  perDevice:    { device: Number, protection: Number, accessories: Number, irisAlly: Number, tabletWithLine: Number, watchWithLine: Number },
  commission:   Number,
  breakdown:    Array,
  source:       String,
  tally:        { type: mongoose.Schema.Types.Mixed },  // aggregate day-tally data (source==="tally")
  rawFields:    { type: mongoose.Schema.Types.Mixed },  // full field capture from the extension (for verification)
  createdAt:    { type: Date, default: Date.now },
});

const PaycheckSchema = new mongoose.Schema({
  userId:    { type: String, required: true },
  weekStart: String,
  amount:    Number,                 // gross paycheck received
  fitw:      { type: Number, default: 0 },  // federal income tax withheld
  fl:        { type: Number, default: 0 },  // FL / state line
  med:       { type: Number, default: 0 },  // Medicare
  ss:        { type: Number, default: 0 },  // Social Security
});

const User     = mongoose.model("User",     UserSchema);
const Order    = mongoose.model("Order",    OrderSchema);
const Paycheck = mongoose.model("Paycheck", PaycheckSchema);

// ── Auth helpers ──────────────────────────────────────────────────────────────
function hashPassword(pw) {
  return crypto.createHash("sha256").update(pw + "ninjasalt2026").digest("hex");
}
function genToken() {
  return crypto.randomBytes(32).toString("hex");
}
async function authMiddleware(req, res, next) {
  const token = req.headers["authorization"]?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "No token" });
  // Match the token in the per-device list OR the legacy single-token field.
  const user = await User.findOne({ $or: [{ tokens: token }, { token }] });
  if (!user) return res.status(401).json({ error: "Invalid token" });
  req.user = user;
  next();
}

// ── Commission calc ───────────────────────────────────────────────────────────
const RATES = { newLine1:25, newLineN:15, reactivation:10, homeLine:10, irisAlly:10, tablet:10, watch:5, protection:2 };

function calcCommission(o) {
  const { type, regularLines, homeLines, perAccount, perDevice } = o;
  let t = 0;
  if (type === "reactivation") {
    t += (regularLines + homeLines) * RATES.reactivation;
  } else {
    if (regularLines >= 1) t += RATES.newLine1;
    if (regularLines >= 2) t += (regularLines - 1) * RATES.newLineN;
    t += (homeLines || 0) * RATES.homeLine;
  }
  if (perAccount?.aarp)    t += 1;
  if (perAccount?.autopay) t += 1;
  t += (perDevice?.device      || 0) * 1;
  t += (perDevice?.protection  || 0) * RATES.protection;
  t += (perDevice?.accessories || 0) * 1;
  t += (perDevice?.irisAlly    || 0) * RATES.irisAlly;
  t += (perDevice?.tabletWithLine || 0) * RATES.tablet;
  t += (perDevice?.watchWithLine  || 0) * RATES.watch;
  return t;
}

function buildBreakdown(o) {
  const { type, regularLines, homeLines, perAccount, perDevice } = o;
  const items = [];
  if (type === "reactivation") {
    const l = regularLines + homeLines;
    if (l > 0) items.push({ label:`Reactivation (${l}L)`, amt:l*RATES.reactivation, color:"#a78bfa" });
  } else {
    if (regularLines >= 1) items.push({ label:"1st Line",             amt:RATES.newLine1,                          color:"#00e5a0" });
    if (regularLines >= 2) items.push({ label:`+${regularLines-1}L`,  amt:(regularLines-1)*RATES.newLineN,         color:"#00b8ff" });
    if (homeLines > 0)     items.push({ label:`Home×${homeLines}`,    amt:homeLines*RATES.homeLine,                color:"#fb923c" });
  }
  if (perAccount?.aarp)    items.push({ label:"AARP",    amt:1,                                      color:"#facc15" });
  if (perAccount?.autopay) items.push({ label:"ACH/Autopay", amt:1,                                  color:"#facc15" });
  if ((perDevice?.device      ||0)>0) items.push({ label:`Device×${perDevice.device}`,               amt:perDevice.device*1,                  color:"#f472b6" });
  if ((perDevice?.protection  ||0)>0) items.push({ label:`Protection×${perDevice.protection}`,       amt:perDevice.protection*RATES.protection,color:"#f472b6" });
  if ((perDevice?.accessories ||0)>0) items.push({ label:`Accessories×${perDevice.accessories}`,     amt:perDevice.accessories*1,             color:"#f472b6" });
  if ((perDevice?.irisAlly    ||0)>0) items.push({ label:`Iris Ally×${perDevice.irisAlly}`,          amt:perDevice.irisAlly*RATES.irisAlly,   color:"#fb923c" });
  if ((perDevice?.tabletWithLine||0)>0) items.push({ label:`Tablet×${perDevice.tabletWithLine}`,     amt:perDevice.tabletWithLine*RATES.tablet,color:"#00b8ff" });
  if ((perDevice?.watchWithLine ||0)>0) items.push({ label:`Watch×${perDevice.watchWithLine}`,       amt:perDevice.watchWithLine*RATES.watch,  color:"#a78bfa" });
  return items;
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status:"ok", service:"Ninja Tracker" }));

// Signup
app.post("/auth/signup", async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error:"Missing fields" });
    const exists = await User.findOne({ email: email.toLowerCase().trim() });
    if (exists) return res.status(409).json({ error:"Email already registered" });
    const user = new User({
      email: email.toLowerCase().trim(),
      name:  name.trim(),
      password: hashPassword(password),
    });
    const token = addToken(user);
    await user.save();
    console.log(`[SIGNUP] ${user.email}`);
    res.json({ token, name:user.name, email:user.email, id:user._id });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// Login
app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error:"Missing fields" });
    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user || user.password !== hashPassword(password))
      return res.status(401).json({ error:"Invalid email or password" });
    const token = addToken(user);   // new device token; existing devices stay logged in
    await user.save();
    console.log(`[LOGIN] ${user.email}`);
    res.json({ token, name:user.name, email:user.email, id:user._id });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// Get data
app.get("/data", authMiddleware, async (req, res) => {
  try {
    const uid = String(req.user._id);
    const [orders, paychecks] = await Promise.all([
      Order.find({ userId:uid }).sort({ createdAt:-1 }).lean(),
      Paycheck.find({ userId:uid }).lean(),
    ]);
    res.json({ orders, paychecks, settings: req.user.settings || {} });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// Save per-user settings (goals + hourly schedule) so they sync across devices
app.post("/settings", authMiddleware, async (req, res) => {
  try {
    const { weekGoal, monthGoal, hourlySchedule, taxRate, attendance, theme, customPresets } = req.body;
    req.user.settings = req.user.settings || {};
    if (weekGoal       !== undefined) req.user.settings.weekGoal       = Number(weekGoal) || 0;
    if (monthGoal      !== undefined) req.user.settings.monthGoal      = Number(monthGoal) || 0;
    if (hourlySchedule !== undefined) req.user.settings.hourlySchedule = hourlySchedule;
    if (taxRate        !== undefined) req.user.settings.taxRate        = Number(taxRate) || 0;
    if (theme          !== undefined) req.user.settings.theme          = theme;
    if (attendance     !== undefined) {
      req.user.settings.attendance = attendance;       // full map; small enough to send whole
      req.user.markModified("settings.attendance");    // Mixed type needs this to persist
    }
    if (customPresets  !== undefined) {
      req.user.settings.customPresets = customPresets;
      req.user.markModified("settings.customPresets");
    }
    await req.user.save();
    res.json({ success:true, settings:req.user.settings });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// Create order
app.post("/orders", authMiddleware, async (req, res) => {
  try {
    const uid = String(req.user._id);
    const raw = req.body;
    let order;

    if (raw.wirelessLines !== undefined) {
      const regularLines   = parseInt(raw.wirelessLines)  || 0;
      const homeLines      = parseInt(raw.homePhoneBase)  || 0;
      const isReactivation = raw.reactivation === true || raw.reactivation === "true";
      order = {
        userId: uid,
        date:   raw.date || new Date().toISOString().split("T")[0],
        note:   raw.notes || raw.orderId || "",
        orderId:raw.orderId || "",
        accountNumber: raw.accountNumber || raw.acctNumber || raw.orderId || "",
        type:   isReactivation ? "reactivation" : "new",
        regularLines, homeLines,
        perAccount: {
          aarp:    raw.aarpDiscount === true || raw.aarpDiscount === "true",
          autopay: raw.autoPay === true || raw.autoPay === "true",
        },
        perDevice: {
          device:         parseInt(raw.newDevices)      || 0,
          protection:     parseInt(raw.protectionPlans) || 0,
          irisAlly:       parseInt(raw.irisAlly)        || 0,
          accessories:    parseInt(raw.accessories)     || 0,
          tabletWithLine: parseInt(raw.tabletWithLine)  || 0,
          watchWithLine:  parseInt(raw.watchWithLine)   || 0,
        },
        source: "extension",
        rawFields: raw.rawFields || undefined,   // full portal capture (incl. whatever holds the account #)
      };
    } else {
      order = { ...raw, userId: uid };
    }

    if (order.source === "tally") {
      // Daily tally mixes new + reactivation + multi-deal line math; trust the precomputed total.
      order.commission = Number(raw.commission) || 0;
      order.breakdown  = Array.isArray(raw.breakdown) ? raw.breakdown : [];
    } else {
      order.commission = calcCommission(order);
      order.breakdown  = buildBreakdown(order);
    }
    const saved = await Order.create(order);
    console.log(`[ORDER] ${req.user.email} — $${order.commission}`);
    res.json({ success:true, order:saved });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// Update order
app.put("/orders/:id", authMiddleware, async (req, res) => {
  try {
    const uid   = String(req.user._id);
    const order = await Order.findOne({ _id:req.params.id, userId:uid });
    if (!order) return res.status(404).json({ error:"Not found" });
    const { commission:_c, breakdown:_b, source:_s, tally:_t, ...fields } = req.body;  // don't let these be overwritten
    Object.assign(order, fields);
    if (order.source !== "tally") {        // tally keeps its precomputed total (e.g. on a date change)
      order.commission = calcCommission(order);
      order.breakdown  = buildBreakdown(order);
    }
    await order.save();
    res.json({ success:true, order });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// Delete order
app.delete("/orders/:id", authMiddleware, async (req, res) => {
  try {
    const uid = String(req.user._id);
    await Order.deleteOne({ _id:req.params.id, userId:uid });
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// Save paycheck (upsert per week, with tax breakdown)
app.post("/paychecks", authMiddleware, async (req, res) => {
  try {
    const uid = String(req.user._id);
    const { weekStart, amount, fitw, fl, med, ss } = req.body;
    await Paycheck.findOneAndUpdate(
      { userId:uid, weekStart },
      { amount:Number(amount)||0, fitw:Number(fitw)||0, fl:Number(fl)||0, med:Number(med)||0, ss:Number(ss)||0 },
      { upsert:true }
    );
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// Delete a paycheck for a given week
app.delete("/paychecks/:weekStart", authMiddleware, async (req, res) => {
  try {
    const uid = String(req.user._id);
    await Paycheck.deleteOne({ userId:uid, weekStart:req.params.weekStart });
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// Reset password
app.post("/auth/reset", async (req, res) => {
  try {
    const { email, password, code } = req.body;
    if (code !== "ninja2026reset") return res.status(401).json({ error:"Invalid reset code" });
    if (!email || !password) return res.status(400).json({ error:"Missing fields" });
    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) return res.status(404).json({ error:"Email not found" });
    user.password = hashPassword(password);
    user.tokens   = [];             // password changed: log out all other devices
    const token   = addToken(user);
    await user.save();
    console.log(`[RESET] ${user.email}`);
    res.json({ token, name:user.name, email:user.email, id:user._id });
  } catch(e) { res.status(500).json({ error:e.message }); }
});
app.get("/admin/users", async (req, res) => {
  if (req.headers["x-admin-key"] !== "ninja2026admin") return res.status(403).json({ error:"Forbidden" });
  const users = await User.find({}, { password:0, token:0, tokens:0 }).lean();
  res.json(users);
});

// Admin - orders
app.get("/admin/orders", async (req, res) => {
  if (req.headers["x-admin-key"] !== "ninja2026admin") return res.status(403).json({ error:"Forbidden" });
  const orders = await Order.find({}).sort({ createdAt:-1 }).lean();
  res.json(orders);
});

// ── Admin management routes ─────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  if (req.headers["x-admin-key"] !== "ninja2026admin") return res.status(403).json({ error:"Forbidden" });
  next();
}

// Delete a user account + all their data (cascade)
app.delete("/admin/users/:id", adminAuth, async (req, res) => {
  try {
    const id = req.params.id;
    await Order.deleteMany({ userId:id });
    await Paycheck.deleteMany({ userId:id });
    await User.deleteOne({ _id:id });
    console.log(`[ADMIN DELETE USER] ${id}`);
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// Reset a user's password (admin sets it); also logs them out everywhere
app.post("/admin/users/:id/password", adminAuth, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error:"Missing password" });
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error:"User not found" });
    user.password = hashPassword(password);
    user.tokens = [];
    user.token  = undefined;
    await user.save();
    console.log(`[ADMIN RESET PW] ${user.email}`);
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// Force-log-out a user (clear all device tokens)
app.post("/admin/users/:id/logout", adminAuth, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error:"User not found" });
    user.tokens = [];
    user.token  = undefined;
    await user.save();
    console.log(`[ADMIN FORCE LOGOUT] ${user.email}`);
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// Edit any order (recompute commission server-side)
app.put("/admin/orders/:id", adminAuth, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error:"Not found" });
    const { userId, _id, ...fields } = req.body;   // never let userId/_id be overwritten
    Object.assign(order, fields);
    order.commission = calcCommission(order);
    order.breakdown  = buildBreakdown(order);
    await order.save();
    res.json({ success:true, order });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// Delete any order
app.delete("/admin/orders/:id", adminAuth, async (req, res) => {
  try {
    await Order.deleteOne({ _id:req.params.id });
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.listen(PORT, () => console.log(`Ninja Tracker running on port ${PORT}`));
