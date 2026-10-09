const path = require("path");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const { Server } = require("socket.io");
const { Matcher, normalizeInterests } = require("./matcher");
const store = require("./store");

const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD; // REQUIRED to enable /admin

const MAX_MSG_LEN = 500;
const RATE_LIMIT = { count: 5, perMs: 3000 };   // 5 messages / 3 seconds
const MAX_CONN_PER_IP = 3;
const TRANSCRIPT_KEEP = 20;

const app = express();
app.set("trust proxy", 1); // Render sits behind a proxy
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 2e3 });

/* ---------- Admin dashboard (HTTP Basic Auth) ---------- */
const safeEq = (a, b) => {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
};
function adminAuth(req, res, next) {
  if (!ADMIN_PASSWORD) return res.status(503).send("Set ADMIN_PASSWORD env var to enable admin.");
  const [u, p] = Buffer.from((req.headers.authorization || "").slice(6), "base64").toString().split(/:(.*)/s);
  if (u && safeEq(u, ADMIN_USER) && safeEq(p || "", ADMIN_PASSWORD)) return next();
  res.set("WWW-Authenticate", 'Basic realm="Chat Duniya admin"').status(401).send("Auth required");
}
app.use("/admin", adminAuth, express.json({ limit: "10kb" }));
app.get("/admin", (_req, res) => res.sendFile(path.join(__dirname, "admin", "admin.html")));
app.get("/admin/api/reports", (_req, res) => res.json({ reports: store.listReports(), stats: store.stats() }));
app.post("/admin/api/reports/:id/dismiss", (req, res) => res.json({ ok: store.setStatus(req.params.id, "dismissed") }));
app.post("/admin/api/reports/:id/ban", (req, res) => {
  const r = store.listReports().find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ ok: false });
  store.ban(r.reportedId, r.reportedIp);
  store.setStatus(r.id, "banned");
  for (const u of users.values()) {
    if (u.clientId === r.reportedId || u.ip === r.reportedIp) u.socket.disconnect(true);
  }
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, "public")));
app.get("/healthz", (_req, res) => res.send("ok")); // use as Render health check

/* ---------- Real-time chat ---------- */
const matcher = new Matcher({ fallbackMs: 10000 });
const users = new Map(); // socket.id -> user
const ipCount = new Map();

const BAD_WORDS = /\b(fuck|shit|bitch|asshole|bastard)\b/gi; // extend as needed
const clean = (t) => String(t ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_MSG_LEN).replace(BAD_WORDS, (w) => "*".repeat(w.length));

const clientIp = (socket) =>
  (socket.handshake.headers["x-forwarded-for"] || socket.handshake.address || "").split(",")[0].trim();

const broadcastOnline = () => io.emit("online", users.size);

function allowed(user) {
  const now = Date.now();
  user.stamps = user.stamps.filter((t) => now - t < RATE_LIMIT.perMs);
  if (user.stamps.length >= RATE_LIMIT.count) return false;
  user.stamps.push(now);
  return true;
}

function startChat({ a, b, shared }) {
  const conv = { msgs: [] };
  const ua = users.get(a.id), ub = users.get(b.id);
  if (!ua || !ub) { // someone vanished between match and start: requeue the other
    for (const u of [ua, ub]) if (u) enqueue(u);
    return;
  }
  ua.partner = ub; ub.partner = ua; ua.conv = ub.conv = conv;
  ua.socket.emit("matched", { shared });
  ub.socket.emit("matched", { shared });
}

function enqueue(user) {
  user.partner = null; user.conv = null;
  user.socket.emit("searching");
  const m = matcher.add({
    id: user.socket.id, clientId: user.clientId,
    interests: user.interests, blocked: user.blocked,
  });
  if (m) startChat(m);
}

function leave(user, { notify = true } = {}) {
  matcher.remove(user.socket.id);
  const p = user.partner;
  if (p) {
    p.partner = null;
    if (notify) p.socket.emit("partner_left");
  }
  user.partner = null; user.conv = null;
}

setInterval(() => matcher.tick().forEach(startChat), 2000);

io.use((socket, next) => {
  const clientId = String(socket.handshake.auth?.clientId || "").slice(0, 64);
  const ip = clientIp(socket);
  if (!/^[0-9a-f-]{16,64}$/i.test(clientId)) return next(new Error("bad_client"));
  if (store.isBanned(clientId, ip)) return next(new Error("banned"));
  if ((ipCount.get(ip) || 0) >= MAX_CONN_PER_IP) return next(new Error("too_many"));
  socket.data = { clientId, ip };
  next();
});

io.on("connection", (socket) => {
  const { clientId, ip } = socket.data;
  ipCount.set(ip, (ipCount.get(ip) || 0) + 1);
  const user = { socket, clientId, ip, interests: [], blocked: new Set(), partner: null, conv: null, stamps: [] };
  users.set(socket.id, user);
  broadcastOnline();

  socket.on("find", (data) => {
    if (user.partner || matcher.has(socket.id)) return;
    user.interests = normalizeInterests(data?.interests);
    enqueue(user);
  });

  socket.on("next", () => { leave(user); enqueue(user); });
  socket.on("end", () => { leave(user); socket.emit("ended"); });

  socket.on("message", (data, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    if (!user.partner) return reply({ ok: false, error: "no_partner" });
    if (!allowed(user)) return reply({ ok: false, error: "slow_down" });
    const text = clean(data?.text);
    const id = String(data?.id || "").slice(0, 40);
    if (!text || !id) return reply({ ok: false, error: "empty" });
    user.conv.msgs.push({ from: clientId, text, at: Date.now() });
    if (user.conv.msgs.length > TRANSCRIPT_KEEP) user.conv.msgs.shift();
    user.partner.socket.emit("message", { id, text });
    reply({ ok: true, text }); // "sent" state (server received it)
  });

  // partner's client confirms it showed the message -> "delivered" state
  socket.on("delivered", ({ id } = {}) => {
    if (user.partner) user.partner.socket.emit("delivered", { id: String(id).slice(0, 40) });
  });

  socket.on("typing", (isTyping) => {
    if (user.partner) user.partner.socket.emit("typing", !!isTyping);
  });

  socket.on("block", () => {
    if (!user.partner) return;
    user.blocked.add(user.partner.clientId);
    socket.emit("blocked");
    leave(user);
  });

  socket.on("report", (data) => {
    const p = user.partner;
    if (!p) return;
    const { autoBanned } = store.addReport({
      reporterId: clientId, reportedId: p.clientId, reportedIp: p.ip,
      reason: data?.reason,
      transcript: user.conv.msgs.map((m) => ({ who: m.from === clientId ? "reporter" : "reported", text: m.text, at: m.at })),
    });
    user.blocked.add(p.clientId);
    socket.emit("reported");
    if (autoBanned) { p.socket.emit("banned"); p.socket.disconnect(true); }
    else leave(user);
  });

  socket.on("disconnect", () => {
    leave(user);
    users.delete(socket.id);
    ipCount.set(ip, Math.max(0, (ipCount.get(ip) || 1) - 1));
    broadcastOnline();
  });
});

server.listen(PORT, () => console.log(`Chat Duniya running on :${PORT}`));