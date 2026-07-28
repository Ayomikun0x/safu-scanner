const SEEN_KEY = "safu_scanner_seen_tokens";
const DUST_THRESHOLD_ETH = 0.05;
const CHAIN_ORDER = ["robinhood", "stable"];

function formatAge(scannedAt) {
  const seconds = Math.floor((Date.now() - scannedAt) / 1000);
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
    unlocked: ["badge-red", "Unlocked"],
    unknown: ["badge-gray", "Unknown"],
  };
  const [cls, label] = map[status] || map.unknown;
  return `<span class="badge ${cls}">LP: ${label}</span>`;
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
        <span class="token-age">${formatAge(t.scannedAt)}</span>
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
      </div>
      ${t.lpOwner ? `
      <div class="lp-owner-row">
        LP holder: <a href="${t.explorerAddressBase}${t.lpOwner}" target="_blank" rel="noopener">${t.lpOwner.slice(0,6)}…${t.lpOwner.slice(-4)}</a>
        <span class="lp-owner-hint">— check if this is a wallet or a locker contract</span>
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

function renderChainSection(chainKey, chainLabel, allTokens, safuTokens, isNewFn) {
  return `
    <section class="chain-section">
      <h2 class="chain-title">${chainLabel}</h2>
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
            <h3>SAFU <span class="column-sub">verified · no risky fns · not upgradeable · &lt;5% top holder · min liquidity</span></h3>
            <span class="count-pill count-pill-green">${safuTokens.length}</span>
          </div>
          <div class="card-list">
            ${safuTokens.length
              ? safuTokens.map((t) => renderCard(t, isNewFn(t))).join("")
              : `<p class="column-empty">None have passed the filter yet.</p>`}
          </div>
        </section>
      </div>
    </section>
  `;
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

  const res = await fetch("/api/tokens");
  const tokens = await res.json();

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
    return b.scannedAt - a.scannedAt;
  };

  let html = "";
  for (const key of chainKeys) {
    const { label, tokens: chainTokens } = byChain.get(key);
    const safuTokens = chainTokens.filter((t) => t.isSafu).sort(sortFn);
    let allTokens = hideSpam
      ? chainTokens.filter((t) => t.baseLiquidity >= DUST_THRESHOLD_ETH)
      : chainTokens;
    allTokens = [...allTokens].sort(sortFn);

    html += renderChainSection(key, label, allTokens, safuTokens, isNew);
  }

  const container = document.getElementById("chainSections");
  container.innerHTML = html || `<p class="column-empty">No chains have data yet.</p>`;
  attachCopyHandlers(container);

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

loadTokens({ scanFirst: true });
setInterval(() => loadTokens({ scanFirst: false }), 60 * 1000);
