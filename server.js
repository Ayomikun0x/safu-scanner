const path = require("path");
const express = require("express");
const session = require("express-session");
const config = require("./config");
const db = require("./db");
const { scanOnce, forceResetScanLock } = require("./scanner");
const { withTimeout } = require("./utils/withTimeout");
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 30 }, // 30 days
  })
);
function requireAuth(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  return res.redirect("/login");
}
// --- Auth routes ---
app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});
app.post("/login", (req, res) => {
  if (req.body.password === config.dashboardPassword) {
    req.session.loggedIn = true;
    return res.redirect("/");
  }
  return res.redirect("/login?error=1");
});
app.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});
// --- Protected dashboard ---
app.get("/", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
// Static assets (CSS/JS) are not sensitive on their own, so no auth gate here --
// only the actual token data and the dashboard page require login.
app.use("/static", express.static(path.join(__dirname, "public")));
app.get("/api/tokens", requireAuth, (req, res) => {
  res.json(db.getAll());
});
app.post("/api/scan-now", requireAuth, async (req, res) => {
  try {
    const result = await scanOnce();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("Manual scan failed:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});
// --- Background scanning loop ---
async function runScanLoop() {
  const startedAt = Date.now();
  try {
    // Hard outer ceiling as a last-resort safety net -- everything inside
    // scanOnce should now already time out on its own well before this, but
    // this guarantees the loop can never be frozen indefinitely no matter
    // what slips through.
    const result = await withTimeout(scanOnce(), 4 * 60 * 1000, "scanOnce");
    const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`Scan complete in ${durationSec}s: ${result.scanned} pools checked, ${result.newTokens} new tokens recorded`);
} catch (err) {
    const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.error(`Scheduled scan failed after ${durationSec}s:`, err.message);
    if (err.message.includes("timed out")) {
      // The outer ceiling tripped -- scanOnce's promise is abandoned, not
      // resolved, so its own scanInProgress=false (in the finally block)
      // never ran. Force it back open so the next cycle isn't blocked.
      forceResetScanLock();
    }
  }
  setTimeout(runScanLoop, config.scanIntervalMinutes * 60 * 1000);
}
app.listen(config.port, () => {
  console.log(`SAFU Scanner running on port ${config.port}`);
  runScanLoop();
});
