// Tiny JSON-file store for reports and bans.
// NOTE: Render's free tier has an ephemeral disk, so this resets on redeploy.
// For real persistence, swap this file for PostgreSQL/MongoDB (great next step).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const FILE = path.join(DIR, "store.json");
const AUTO_BAN_REPORTERS = 3; // distinct reporters before an automatic ban

let db = { reports: [], bannedClients: [], bannedIps: [] };
try {
  fs.mkdirSync(DIR, { recursive: true });
  db = { ...db, ...JSON.parse(fs.readFileSync(FILE, "utf8")) };
} catch { /* first run */ }

const save = () => {
  try { fs.writeFileSync(FILE, JSON.stringify(db, null, 2)); }
  catch (e) { console.error("store save failed:", e.message); }
};

module.exports = {
  isBanned: (clientId, ip) => db.bannedClients.includes(clientId) || db.bannedIps.includes(ip),

  ban(clientId, ip) {
    if (clientId && !db.bannedClients.includes(clientId)) db.bannedClients.push(clientId);
    if (ip && !db.bannedIps.includes(ip)) db.bannedIps.push(ip);
    save();
  },

  addReport({ reporterId, reportedId, reportedIp, reason, transcript }) {
    const report = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      reporterId, reportedId, reportedIp,
      reason: String(reason || "other").slice(0, 100),
      transcript,
      status: "open",
    };
    db.reports.push(report);
    const reporters = new Set(
      db.reports.filter((r) => r.reportedId === reportedId).map((r) => r.reporterId)
    );
    const autoBanned = reporters.size >= AUTO_BAN_REPORTERS;
    if (autoBanned) this.ban(reportedId, reportedIp); else save();
    return { report, autoBanned };
  },

  listReports: () => [...db.reports].reverse(),

  setStatus(id, status) {
    const r = db.reports.find((x) => x.id === id);
    if (r) { r.status = status; save(); }
    return !!r;
  },

  stats: () => ({
    open: db.reports.filter((r) => r.status === "open").length,
    bannedClients: db.bannedClients.length,
    bannedIps: db.bannedIps.length,
  }),
};