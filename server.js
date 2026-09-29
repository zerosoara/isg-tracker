const express  = require("express");
const cors     = require("cors");
const crypto   = require("crypto");
const mongoose = require("mongoose");
const Stripe   = require("stripe");

const app  = express();
const PORT = process.env.PORT || 3000;

// Connection string comes ONLY from the environment. No credentials in code.
const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error("FATAL: MONGO_URI environment variable is not set. Set it in the Render dashboard.");
  process.exit(1);
}

// ── Stripe / subscription config (all from env — nothing secret in code) ────────
// If STRIPE_SECRET_KEY isn't set yet, payments are simply disabled (checkout/webhook
// return 503) — everything else (comped users, existing accounts) keeps working fine.
const STRIPE_SECRET_KEY     = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const STRIPE_PRICE_REGULAR  = process.env.STRIPE_PRICE_REGULAR || "";   // Stripe Price ID, regular plan
const STRIPE_PRICE_FOUNDING = process.env.STRIPE_PRICE_FOUNDING || "";  // Stripe Price ID, founding-member plan
const FOUNDING_MEMBER_LIMIT = parseInt(process.env.FOUNDING_MEMBER_LIMIT) || 5; // how many get the founding price — change anytime in Render, no redeploy needed
const PRICE_DISPLAY_REGULAR  = process.env.PRICE_DISPLAY_REGULAR  || "19.99";
const PRICE_DISPLAY_FOUNDING = process.env.PRICE_DISPLAY_FOUNDING || "9.99";
const APP_URL = process.env.APP_URL || "https://zerosoara.github.io/isg-tracker";
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

// Stripe webhook needs the RAW request body to verify the signature, so this route
// must be registered before express.json() (which would otherwise parse/consume it).
app.post("/billing/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(503).send("Stripe not configured");
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("[STRIPE] webhook signature error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const userId = session.client_reference_id;
      if (userId) {
        const user = await User.findById(userId);
        if (user) {
          user.settings = user.settings || {};
          user.settings.paid = true;
          if (session.metadata && session.metadata.founding === "1") user.settings.foundingMember = true;
          if (session.customer)     user.stripeCustomerId     = session.customer;
          if (session.subscription) user.stripeSubscriptionId = session.subscription;
          await user.save();
          console.log(`[STRIPE] ${user.email} subscribed${user.settings.foundingMember ? " (founding member)" : ""}`);
        }
      }
    } else if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
      const sub = event.data.object;
      const user = await User.findOne({ stripeSubscriptionId: sub.id });
      if (user) {
        const active = sub.status === "active" || sub.status === "trialing";
        user.settings = user.settings || {};
        user.settings.paid = active;
        await user.save();
        console.log(`[STRIPE] ${user.email} subscription -> ${sub.status}`);
      }
    }
  } catch (e) { console.error("[STRIPE] webhook handling error:", e.message); }
  res.json({ received: true });
});

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
  stripeCustomerId:     String,
  stripeSubscriptionId: String,
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
    hourlyPaused:   { type: Boolean, default: false }, // vacation / no longer working — hides hourly comparisons
    paid:           { type: Boolean, default: false }, // active paid subscription (set by Stripe webhook)
    comped:         { type: Boolean, default: false }, // admin-granted free access (e.g. JC, beta testers)
    foundingMember: { type: Boolean, default: false }, // locked in the discounted founding-member price
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
  adh:       { type: Boolean, default: false }, // hit 85%+ ADH this pay period -> +$2/New Account line bonus
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
// Blocks order/paycheck logging for accounts with no active subscription and no comp/legacy access.
// Reading data (/data) is NEVER gated — a brand-new unpaid account just has nothing in it yet, so
// there's nothing to hide, and gating reads would break the frontend's normal load/retry logic.
function requirePaid(req, res, next) {
  const s = req.user.settings || {};
  if (s.paid || s.comped) return next();
  return res.status(402).json({ error: "Subscription required", needsSubscription: true });
}

// ── Commission calc ───────────────────────────────────────────────────────────
const RATES = { newLine1:25, newLineN:15, existingLine:15, reactivation:10, homeLine:15, irisAlly:15, tablet:10, watch:5, protection:2 };

// The ISG portal has no field for "existing customer adding a line" — the extension can't see it.
// Workaround: type this word into the portal's Notes field and the order auto-tags as "existing".
// The word is stripped out of the saved note so it doesn't clutter History.
const EXISTING_CUSTOMER_CODEWORD = "blue";
function detectExistingCodeword(notes) {
  const re = new RegExp(`\\b${EXISTING_CUSTOMER_CODEWORD}\\b`, "i");
  const found = re.test(notes || "");
  const cleaned = found ? (notes || "").replace(re, "").replace(/\s{2,}/g, " ").trim() : (notes || "");
  return { found, cleaned };
}

function calcCommission(o) {
  const { type, regularLines, homeLines, perAccount, perDevice } = o;
  let t = 0;
  if (type === "reactivation") {
    t += (regularLines + homeLines) * RATES.reactivation;
  } else if (type === "existing") {
    t += (regularLines || 0) * RATES.existingLine;
    t += (homeLines || 0) * RATES.homeLine;
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
  } else if (type === "existing") {
    if (regularLines > 0) items.push({ label:`Existing×${regularLines}`, amt:regularLines*RATES.existingLine, color:"#00b8ff" });
    if (homeLines > 0)    items.push({ label:`Home×${homeLines}`,        amt:homeLines*RATES.homeLine,        color:"#fb923c" });
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
    const s = req.user.settings || {};
    const hasAccess = !!(s.paid || s.comped);
    const billing = { paid: !!s.paid, comped: !!s.comped, foundingMember: !!s.foundingMember, hasAccess };
    if (!hasAccess) {
      // Only unpaid accounts need the founding-spots count (cheap enough — they're not looping /data forever once they pay)
      const foundingCount = await User.countDocuments({ "settings.foundingMember": true });
      billing.foundingLimit     = FOUNDING_MEMBER_LIMIT;
      billing.foundingSpotsLeft = Math.max(0, FOUNDING_MEMBER_LIMIT - foundingCount);
      billing.priceRegular      = PRICE_DISPLAY_REGULAR;
      billing.priceFounding     = PRICE_DISPLAY_FOUNDING;
    }
    res.json({ orders, paychecks, settings: s, billing });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// Save per-user settings (goals + hourly schedule) so they sync across devices
app.post("/settings", authMiddleware, async (req, res) => {
  try {
    const { weekGoal, monthGoal, hourlySchedule, taxRate, attendance, theme, customPresets, hourlyPaused } = req.body;
    req.user.settings = req.user.settings || {};
    if (weekGoal       !== undefined) req.user.settings.weekGoal       = Number(weekGoal) || 0;
    if (monthGoal      !== undefined) req.user.settings.monthGoal      = Number(monthGoal) || 0;
    if (hourlySchedule !== undefined) req.user.settings.hourlySchedule = hourlySchedule;
    if (taxRate        !== undefined) req.user.settings.taxRate        = Number(taxRate) || 0;
    if (theme          !== undefined) req.user.settings.theme          = theme;
    if (hourlyPaused   !== undefined) req.user.settings.hourlyPaused   = !!hourlyPaused;
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

// ── Billing (Stripe) ─────────────────────────────────────────────────────────────
// Start a subscription checkout. Automatically gives founding-member pricing to the
// first FOUNDING_MEMBER_LIMIT people who complete payment (the count updates live).
app.post("/billing/checkout", authMiddleware, async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ error: "Payments aren't set up yet — ask Chad." });
    const foundingCount = await User.countDocuments({ "settings.foundingMember": true });
    const isFounding = foundingCount < FOUNDING_MEMBER_LIMIT && !!STRIPE_PRICE_FOUNDING;
    const priceId = isFounding ? STRIPE_PRICE_FOUNDING : STRIPE_PRICE_REGULAR;
    if (!priceId) return res.status(503).json({ error: "Subscription price isn't configured yet — ask Chad." });

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: req.user.email,
      client_reference_id: String(req.user._id),
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${APP_URL}/?checkout=success`,
      cancel_url:  `${APP_URL}/?checkout=cancel`,
      metadata: { userId: String(req.user._id), founding: isFounding ? "1" : "0" },
    });
    res.json({ url: session.url, founding: isFounding });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Open the Stripe-hosted portal so a subscriber can update/cancel their own subscription.
app.post("/billing/portal", authMiddleware, async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ error: "Payments aren't set up yet — ask Chad." });
    if (!req.user.stripeCustomerId) return res.status(400).json({ error: "No subscription on file." });
    const session = await stripe.billingPortal.sessions.create({
      customer: req.user.stripeCustomerId,
      return_url: `${APP_URL}/`,
    });
    res.json({ url: session.url });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Create order
app.post("/orders", authMiddleware, requirePaid, async (req, res) => {
  try {
    const uid = String(req.user._id);
    const raw = req.body;
    let order;

    if (raw.wirelessLines !== undefined) {
      const regularLines   = parseInt(raw.wirelessLines)  || 0;
      const homeLines      = parseInt(raw.homePhoneBase)  || 0;
      const isReactivation = raw.reactivation === true || raw.reactivation === "true";
      const { found:isExistingCustomer, cleaned:cleanedNotes } = detectExistingCodeword(raw.notes);
      order = {
        userId: uid,
        date:   raw.date || new Date().toISOString().split("T")[0],
        note:   cleanedNotes || raw.orderId || "",
        orderId:raw.orderId || "",
        accountNumber: raw.accountNumber || raw.acctNumber || raw.orderId || "",
        type:   isReactivation ? "reactivation" : (isExistingCustomer ? "existing" : "new"),
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
app.put("/orders/:id", authMiddleware, requirePaid, async (req, res) => {
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
app.post("/paychecks", authMiddleware, requirePaid, async (req, res) => {
  try {
    const uid = String(req.user._id);
    const { weekStart, amount, fitw, fl, med, ss, adh } = req.body;
    await Paycheck.findOneAndUpdate(
      { userId:uid, weekStart },
      { amount:Number(amount)||0, fitw:Number(fitw)||0, fl:Number(fl)||0, med:Number(med)||0, ss:Number(ss)||0, adh:!!adh },
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

// Grant/revoke free access (e.g. JC, beta testers) — bypasses the paid-subscription gate
app.post("/admin/users/:id/comp", adminAuth, async (req, res) => {
  try {
    const { comped } = req.body;
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error:"User not found" });
    user.settings = user.settings || {};
    user.settings.comped = !!comped;
    await user.save();
    console.log(`[ADMIN COMP] ${user.email} -> ${!!comped}`);
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
