const express  = require("express");
const cors     = require("cors");
const crypto   = require("crypto");
const mongoose = require("mongoose");

const app  = express();
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://zerosoara3:DestroyISG25!@ninja.utdoxfb.mongodb.net/ninjatracker?appName=Ninja";

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
  token:     String,
  createdAt: { type: Date, default: Date.now },
});

const OrderSchema = new mongoose.Schema({
  userId:       { type: String, required: true },
  date:         String,
  note:         String,
  orderId:      String,
  type:         { type: String, default: "new" },
  regularLines: { type: Number, default: 0 },
  homeLines:    { type: Number, default: 0 },
  perAccount:   { aarp: Boolean, autopay: Boolean },
  perDevice:    { device: Number, protection: Number, accessories: Number, irisAlly: Number, tabletWithLine: Number, watchWithLine: Number },
  commission:   Number,
  breakdown:    Array,
  source:       String,
  createdAt:    { type: Date, default: Date.now },
});

const PaycheckSchema = new mongoose.Schema({
  userId:    { type: String, required: true },
  weekStart: String,
  amount:    Number,
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
  const user = await User.findOne({ token });
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
    const user = await User.create({
      email: email.toLowerCase().trim(),
      name:  name.trim(),
      password: hashPassword(password),
      token: genToken(),
    });
    console.log(`[SIGNUP] ${user.email}`);
    res.json({ token:user.token, name:user.name, email:user.email, id:user._id });
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
    user.token = genToken();
    await user.save();
    console.log(`[LOGIN] ${user.email}`);
    res.json({ token:user.token, name:user.name, email:user.email, id:user._id });
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
    res.json({ orders, paychecks });
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
      };
    } else {
      order = { ...raw, userId: uid };
    }

    order.commission = calcCommission(order);
    order.breakdown  = buildBreakdown(order);
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
    Object.assign(order, req.body);
    order.commission = calcCommission(order);
    order.breakdown  = buildBreakdown(order);
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

// Save paycheck
app.post("/paychecks", authMiddleware, async (req, res) => {
  try {
    const uid = String(req.user._id);
    const { weekStart, amount } = req.body;
    await Paycheck.findOneAndUpdate(
      { userId:uid, weekStart },
      { amount:Number(amount) },
      { upsert:true }
    );
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
    user.token    = genToken();
    await user.save();
    console.log(`[RESET] ${user.email}`);
    res.json({ token:user.token, name:user.name, email:user.email, id:user._id });
  } catch(e) { res.status(500).json({ error:e.message }); }
});
app.get("/admin/users", async (req, res) => {
  if (req.headers["x-admin-key"] !== "ninja2026admin") return res.status(403).json({ error:"Forbidden" });
  const users = await User.find({}, { password:0, token:0 }).lean();
  res.json(users);
});

// Admin - orders
app.get("/admin/orders", async (req, res) => {
  if (req.headers["x-admin-key"] !== "ninja2026admin") return res.status(403).json({ error:"Forbidden" });
  const orders = await Order.find({}).sort({ createdAt:-1 }).lean();
  res.json(orders);
});

app.listen(PORT, () => console.log(`Ninja Tracker running on port ${PORT}`));
