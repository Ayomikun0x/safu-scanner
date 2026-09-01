const SEEN_KEY = "safu_scanner_seen_tokens";
const DUST_THRESHOLD_ETH = 0.05;
const CHAIN_ORDER = ["robinhood"];

let filterState = { activeFilter: "all", minLiquidity: 0 };

function formatAge(timestampMs) {
  const seconds = Math.floor((Date.now() - timestampMs) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function getSeenAddresses() {
  try {
    return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || "[]"));
  } catch {
    return new Set();
  }
}

function saveSeenAddresses(addresses) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...addresses]));
  } catch {}
}

function formatCompactUsd(value) {
  if (value === null || value === undefined) return "—";
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(6)}`;
}

function lpBadge(status) {
  const map = {
    burned: ["badge-green", "Burned"],
    locked: ["badge-green", "Locked"],
    "locked-risky": ["badge-red", "Locked (risky)"],
    "locked-unverified": ["badge-amber", "Locked (unverified)"],
    "locked-recheck-needed": ["badge-amber", "Locked (rechecking)"],
    unlocked: ["badge-red", "Unlocked"],
    unknown: ["badge-gray", "Unknown"],
  };
  const [cls, label] = map[status] || map.unknown;
  return `<span class="badge ${cls}">LP: ${label}</span>`;
}

function lpOwnerHint(t) {
  if (t.lpLockStatus === "locked-risky" && t.lpLockerRiskyFunctions?.length) {
    return `<span class="lp-owner-hint lp-owner-hint-risk">— locker contract exposes: ${t.lpLockerRiskyFunctions.join(", ")}</span>`;
  }
  if (t.lpLockStatus === "locked-unverified") {
    return `<span class="lp-owner-hint">— locker contract source isn't verified, can't confirm the lock holds</span>`;
  }
  if (t.lpLockStatus === "locked-recheck-needed") {
    return `<span class="lp-owner-hint">— explorer was rate-limited, rechecking on a later scan</span>`;
  }
  if (t.lpLockStatus === "locked") {
    return `<span class="lp-owner-hint">— known locker, source checked, no early-exit functions found</span>`;
  }
  return `<span class="lp-owner-hint">— check if this is a wallet or a locker contract</span>`;
}

function verifiedBadge(verified) {
  return verified
    ? `<span class="badge badge-green">Verified</span>`
    : `<span class="badge badge-red">Unverified</span>`;
}

function proxyBadge(isProxy) {
  return isProxy ? `<span class="badge badge-red">Upgradeable</span>` : "";
}

function riskyBadge(riskyFunctions) {
  if (riskyFunctions && riskyFunctions.length) {
    return `<span class="badge badge-red">${riskyFunctions.join(", ")}</span>`;
  }
  return `<span class="badge badge-green">No risky fns</span>`;
}

function holdingBadge(t) {
  if (t.topHolderDataAvailable === false) {
    return `<span class="badge badge-gray">Top holder: n/a on this chain</span>`;
  }
  const pct = t.topHolderPct;
  if (pct === null || pct === undefined) return `<span class="badge badge-gray">Top holder: unknown</span>`;
  let cls = "badge-green";
  if (pct >= 20) cls = "badge-red";
  else if (pct >= 5) cls = "badge-amber";
  return `<span class="badge ${cls}">Top holder: ${pct.toFixed(1)}%</span>`;
}

function spoofBadge(t) {
  if (t.spoofedIdentity) {
    return `<span class="badge badge-red">⚠ Name/symbol looks spoofed</span>`;
  }
  return "";
}

function ownershipBadge(t) {
  if (t.ownershipRenounced === true) {
    return `<span class="badge badge-green">Ownership: renounced</span>`;
  }
  if (t.ownershipRenounced === false) {
    return `<span class="badge badge-red">Ownership: active</span>`;
  }
  return `<span class="badge badge-gray">Ownership: n/a</span>`;
}

function deployerBadge(t) {
  const launches = t.deployerLaunches || 0;
  const rugged = t.deployerRuggedCount || 0;
  if (!t.deployerAddress) {
    return `<span class="badge badge-gray">Deployer: unknown</span>`;
  }
  if (rugged > 0) {
    return `<span class="badge badge-red">Deployer: ${rugged} rugged of ${launches}</span>`;
  }
  if (launches > 1) {
    return `<span class="badge badge-green">Deployer: ${launches} launches, clean</span>`;
  }
  return `<span class="badge badge-gray">Deployer: first launch seen</span>`;
}

function sniperBadge(t) {
  const pct = t.earlySniperPct;
  if (pct === null || pct === undefined) {
    return `<span class="badge badge-gray">Sniping: n/a</span>`;
  }
  let cls = "badge-green";
  if (pct >= 30) cls = "badge-red";
  else if (pct >= 15) cls = "badge-amber";
  return `<span class="badge ${cls}">Early buyers: ${pct.toFixed(0)}%</span>`;
}

function repeatSniperBadge(t) {
  if (t.sniperWallets && t.sniperWallets.some((w) => w.isRepeatSniper)) {
    return `<span class="badge badge-red">🎯 Repeat sniper wallet involved</span>`;
  }
  return "";
}

function pumpWatchBadge(t) {
  if (!t.isPumpWatch) return "";
  return `<span class="badge badge-amber">⚠ Deployer: ${t.deployerLaunches || 0}/${t.deployerLaunches || 0} launches hit 2x+</span>`;
}

function renderCard(t, isNew) {
  return `
    <div class="token-card ${t.isSafu ? "is-safu" : ""}">
      <div class="card-top">
        <span>
          <span class="token-name">${t.name}</span><span class="token-symbol">${t.symbol}</span>
          ${isNew ? '<span class="new-badge">NEW</span>' : ""}
        </span>
        <span class="token-liq">${t.baseLiquidity.toFixed(3)} ${t.baseSymbol}</span>
      </div>
      <div class="card-stats-row">
        <span class="stat-item">MC <strong>${formatCompactUsd(t.marketCapUsd)}</strong></span>
        <span class="stat-item">Price <strong>${formatCompactUsd(t.priceUsd)}</strong></span>
        <span class="token-age">${formatAge(t.launchedAt || t.scannedAt)}</span>
      </div>
      <div class="card-addr-row">
        <span class="token-addr">${t.tokenAddress}</span>
        <button class="copy-btn" data-addr="${t.tokenAddress}">Copy CA</button>
      </div>
      <div class="card-badges">
        ${verifiedBadge(t.verified)}
        ${proxyBadge(t.isProxy)}
        ${riskyBadge(t.riskyFunctions)}
        ${holdingBadge(t)}
        ${lpBadge(t.lpLockStatus)}
        ${ownershipBadge(t)}
        ${deployerBadge(t)}
        ${sniperBadge(t)}
        ${repeatSniperBadge(t)}
        ${spoofBadge(t)}
        ${pumpWatchBadge(t)}
      </div>
      ${t.lpOwner ? `
      <div class="lp-owner-row">
        LP holder: <a href="${t.explorerAddressBase}${t.lpOwner}" target="_blank" rel="noopener">${t.lpOwner.slice(0,6)}…${t.lpOwner.slice(-4)}</a>
        ${lpOwnerHint(t)}
      </div>` : ""}
      <div class="card-links">
        <a href="${t.explorerAddressBase}${t.tokenAddress}" target="_blank" rel="noopener">Explorer</a>
        <a href="${t.uniswapPoolUrlBase}${t.poolAddress}" target="_blank" rel="noopener">Pool</a>
      </div>
    </div>
  `;
}

function attachCopyHandlers(container) {
  container.querySelectorAll(".copy-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const addr = btn.getAttribute("data-addr");
      try {
        await navigator.clipboard.writeText(addr);
        const original = btn.textContent;
        btn.textContent = "Copied";
        btn.classList.add("copied");
        setTimeout(() => {
          btn.textContent = original;
          btn.classList.remove("copied");
        }, 1200);
      } catch (err) {
        console.error("Copy failed:", err);
      }
    });
  });
}

function computeHourlyActivity(tokens, hours) {
  const now = Date.now();
  const buckets = new Array(hours).fill(0);
  for (const t of tokens) {
    const ts = t.launchedAt || t.scannedAt;
    if (!ts) continue;
    const hoursAgo = Math.floor((now - ts) / (60 * 60 * 1000));
    if (hoursAgo >= 0 && hoursAgo < hours) {
      buckets[hours - 1 - hoursAgo] += 1;
    }
  }
  return buckets;
}

function renderTerminalHeader(chainLabel, allTokens, safuTokens, pumpWatchTokens, sniperTokens, ruggedTokens) {
  const buckets = computeHourlyActivity(allTokens, 12);
  const maxBucket = Math.max(...buckets, 1);
  const barsHtml = buckets
    .map((count) => {
      const pct = count > 0 ? Math.max((count / maxBucket) * 100, 15) : 4;
      return `<div class="term-bar" style="height:${pct}%;"></div>`;
    })
    .join("");

  const chip = (key, label) =>
    `<button class="term-chip ${filterState.activeFilter === key ? "term-chip-active" : ""}" data-filter="${key}">${label}</button>`;

  return `
    <div class="terminal-header">
      <div class="terminal-topline">
        <span class="terminal-title">◈ SAFU_SCANNER // ${chainLabel.toUpperCase().replace(/ /g, "_")}</span>
        <span class="terminal-live">LIVE</span>
      </div>
      <div class="terminal-stats-row">
        <div class="terminal-stat"><span class="terminal-stat-label">SCANNED</span><span class="terminal-stat-value">${allTokens.length}</span></div>
        <div class="terminal-stat"><span class="terminal-stat-label">SAFU</span><span class="terminal-stat-value terminal-green">${safuTokens.length}</span></div>
        <div class="terminal-stat"><span class="terminal-stat-label">PUMP_WATCH</span><span class="terminal-stat-value terminal-amber">${pumpWatchTokens.length}</span></div>
        <div class="terminal-stat"><span class="terminal-stat-label">SNIPERS</span><span class="terminal-stat-value terminal-amber">${sniperTokens.length}</span></div>
        <div class="terminal-stat"><span class="terminal-stat-label">RUGGED</span><span class="terminal-stat-value terminal-red">${ruggedTokens.length}</span></div>
      </div>
      <div class="terminal-activity-row">
        <span class="terminal-activity-label">12H_ACTIVITY</span>
        <div class="terminal-bars">${barsHtml}</div>
      </div>
      <div class="terminal-chip-row">
        ${chip("all", "ALL")}
        ${chip("verified", "VERIFIED")}
        ${chip("safu", "SAFU")}
        <input type="number" min="0" step="0.1" class="term-liq-input" id="minLiqInput" placeholder="MIN_LIQ" value="${filterState.minLiquidity || ""}" />
      </div>
    </div>
  `;
}

function applyHeaderFilters(tokens) {
  return tokens.filter((t) => {
    if (filterState.activeFilter === "verified" && !t.verified) return false;
    if (filterState.activeFilter === "safu" && !t.isSafu) return false;
    if (filterState.minLiquidity && t.baseLiquidity < filterState.minLiquidity) return false;
    return true;
  });
}

function renderChainSection(chainKey, chainLabel, allTokens, safuTokens, pumpWatchTokens, sniperTokens, ruggedTokens, isNewFn) {
  return `
    <section class="chain-section">
      ${renderTerminalHeader(chainLabel, allTokens, safuTokens, pumpWatchTokens, sniperTokens, ruggedTokens)}
      <div class="board">
        <section class="column">
          <div class="column-head">
            <h3>All launches</h3>
            <span class="count-pill">${allTokens.length}</span>
          </div>
          <div class="card-list">
            ${allTokens.length
              ? allTokens.map((t) => renderCard(t, isNewFn(t))).join("")
              : `<p class="column-empty">Nothing scanned yet.</p>`}
          </div>
        </section>
        <section class="column">
          <div class="column-head">
            <h3>SAFU <span class="column-sub">verified · no risky fns · not upgradeable · &lt;5% top holder · min liquidity · LP locked · ownership renounced · clean deployer · no sniping</span></h3>
            <span class="count-pill count-pill-green">${safuTokens.length}</span>
          </div>
          <div class="card-list">
            ${safuTokens.length
              ? safuTokens.map((t) => renderCard(t, isNewFn(t))).join("")
              : `<p class="column-empty">None have passed the filter yet.</p>`}
          </div>
        </section>
      </div>
      <div class="pump-watch-section">
        <div class="column-head">
          <h3>⚠️ Pump Watch <span class="column-sub">deployers with a rug history who ALSO hit 2x+ before -- not a safety signal</span></h3>
          <span class="count-pill">${pumpWatchTokens.length}</span>
        </div>
        <p class="disclaimer">This is a historical pattern only -- it means this wallet's past tokens pumped before rugging, not that this specific token is safe. Treat as high-risk speculation, not a recommendation.</p>
        <div class="card-list">
          ${pumpWatchTokens.length
            ? pumpWatchTokens.map((t) => renderCard(t, isNewFn(t))).join("")
            : `<p class="column-empty">No repeat pump-then-rug patterns detected yet.</p>`}
        </div>
      </div>
      <div class="sniper-section">
        <div class="column-head">
          <h3>🎯 Snipers <span class="column-sub">heavy early-buyer concentration, or a wallet flagged as a repeat sniper across multiple launches</span></h3>
          <span class="count-pill">${sniperTokens.length}</span>
        </div>
        <p class="disclaimer">High early concentration isn't automatically malicious, but it's worth knowing who got in first and how much of supply they hold.</p>
        <div class="card-list">
          ${sniperTokens.length
            ? sniperTokens.map((t) => renderCard(t, isNewFn(t))).join("")
            : `<p class="column-empty">No sniper-heavy launches detected yet.</p>`}
        </div>
      </div>
    </section>
  `;
}

function renderRepeatSnipers(repeatSnipers) {
  if (!repeatSnipers.length) {
    return `
      <section class="repeat-snipers-section">
        <div class="column-head">
          <h2>🎯 Repeat Snipers <span class="column-sub">wallets seen as early buyers across multiple different launches, any chain</span></h2>
          <span class="count-pill">0</span>
        </div>
        <p class="column-empty">No repeat-sniper wallets identified yet.</p>
      </section>
    `;
  }
  const rows = repeatSnipers
    .map(
      (s) => `
    <div class="sniper-wallet-row">
      <span class="token-addr">${s.wallet}</span>
      <button class="copy-btn" data-addr="${s.wallet}">Copy</button>
      <span class="badge badge-amber">${s.launchesCount} launches</span>
    </div>`
    )
    .join("");
  return `
    <section class="repeat-snipers-section">
      <div class="column-head">
        <h2>🎯 Repeat Snipers <span class="column-sub">wallets seen as early buyers across multiple different launches, any chain</span></h2>
        <span class="count-pill">${repeatSnipers.length}</span>
      </div>
      <div class="sniper-wallet-list">${rows}</div>
    </section>
  `;
}

function ensureRepeatSnipersContainer() {
  let el = document.getElementById("repeatSnipersSection");
  if (!el) {
    el = document.createElement("div");
    el.id = "repeatSnipersSection";
    document.getElementById("chainSections").insertAdjacentElement("beforebegin", el);
  }
  return el;
}

async function loadTokens({ scanFirst } = {}) {
  if (scanFirst) {
    const status = document.getElementById("lastUpdated");
    status.textContent = "Scanning…";
    try {
      await fetch("/api/scan-now", { method: "POST" });
    } catch (err) {
      console.error("Initial scan failed:", err);
    }
  }

  const [tokensRes, snipersRes] = await Promise.all([
    fetch("/api/tokens"),
    fetch("/api/snipers"),
  ]);
  const tokens = await tokensRes.json();
  const repeatSnipers = await snipersRes.json();

  const hideSpam = document.getElementById("hideSpamToggle").checked;
  const sortBy = document.getElementById("sortSelect").value;
  const seen = getSeenAddresses();
  const isNew = (t) => !seen.has(`${t.chain}:${t.tokenAddress}`);

  const byChain = new Map();
  for (const t of tokens) {
    if (!byChain.has(t.chain)) byChain.set(t.chain, { label: t.chainLabel, tokens: [] });
    byChain.get(t.chain).tokens.push(t);
  }

  const chainKeys = [...byChain.keys()].sort((a, b) => {
    const ai = CHAIN_ORDER.indexOf(a);
    const bi = CHAIN_ORDER.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });

  const sortFn = (a, b) => {
    if (sortBy === "liquidity") return b.baseLiquidity - a.baseLiquidity;
    if (sortBy === "mcap") return (b.marketCapUsd || 0) - (a.marketCapUsd || 0);
    return (b.launchedAt || b.scannedAt) - (a.launchedAt || a.scannedAt);
  };

  let html = "";
  for (const key of chainKeys) {
    const { label, tokens: chainTokens } = byChain.get(key);
    const safuTokens = chainTokens.filter((t) => t.isSafu).sort(sortFn);
    const pumpWatchTokens = chainTokens.filter((t) => t.isPumpWatch).sort(sortFn);
    const sniperTokens = chainTokens.filter((t) => t.isSniperFlagged).sort(sortFn);
    const ruggedTokens = chainTokens.filter((t) => t.ruggedFlagged);

    let allTokens = hideSpam
      ? chainTokens.filter((t) => t.baseLiquidity >= DUST_THRESHOLD_ETH)
      : chainTokens;
    allTokens = applyHeaderFilters(allTokens);
    allTokens = [...allTokens].sort(sortFn);

    html += renderChainSection(key, label, allTokens, safuTokens, pumpWatchTokens, sniperTokens, ruggedTokens, isNew);
  }

  const container = document.getElementById("chainSections");
  container.innerHTML = html || `<p class="column-empty">No chains have data yet.</p>`;
  attachCopyHandlers(container);

  const repeatSnipersContainer = ensureRepeatSnipersContainer();
  repeatSnipersContainer.innerHTML = renderRepeatSnipers(repeatSnipers);
  attachCopyHandlers(repeatSnipersContainer);

  tokens.forEach((t) => seen.add(`${t.chain}:${t.tokenAddress}`));
  saveSeenAddresses(seen);

  document.getElementById("lastUpdated").textContent =
    "Updated " + new Date().toLocaleTimeString();
}

document.getElementById("refreshBtn").addEventListener("click", async () => {
  const btn = document.getElementById("refreshBtn");
  btn.textContent = "Scanning…";
  btn.disabled = true;
  try {
    await fetch("/api/scan-now", { method: "POST" });
  } catch (err) {
    console.error(err);
  }
  await loadTokens();
  btn.textContent = "Rescan now";
  btn.disabled = false;
});

document.getElementById("hideSpamToggle").addEventListener("change", () => loadTokens({ scanFirst: false }));
document.getElementById("sortSelect").addEventListener("change", () => loadTokens({ scanFirst: false }));

document.getElementById("chainSections").addEventListener("click", (e) => {
  const chip = e.target.closest(".term-chip");
  if (!chip) return;
  filterState.activeFilter = chip.getAttribute("data-filter");
  loadTokens({ scanFirst: false });
});

document.getElementById("chainSections").addEventListener("change", (e) => {
  if (e.target.id === "minLiqInput") {
    filterState.minLiquidity = parseFloat(e.target.value) || 0;
    loadTokens({ scanFirst: false });
  }
});

loadTokens({ scanFirst: true });
setInterval(() => loadTokens({ scanFirst: false }), 60 * 1000);
