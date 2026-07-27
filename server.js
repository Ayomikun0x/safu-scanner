const path = require("path");
const express = require("express");
const session = require("express-session");
const config = require("./config");
const db = require("./db");
const { scanOnce } = require("./scanner");

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

// Static assets (CSS/JS) are not sensitive on their own, so no auth gate here —
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
  try {
    const result = await scanOnce();
    console.log(`Scan complete: ${result.scanned} pools checked, ${result.newTokens} new tokens recorded`);
  } catch (err) {
    console.error("Scheduled scan failed:", err.message);
  }
  setTimeout(runScanLoop, config.scanIntervalMinutes * 60 * 1000);
}

app.listen(config.port, () => {
  console.log(`SAFU Scanner running on port ${config.port}`);
  runScanLoop();
});
