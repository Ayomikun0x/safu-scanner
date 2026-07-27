const EXPLORER_BASE = "https://robinhoodchain.blockscout.com/address/";

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

function riskyBadge(riskyFunctions) {
  if (riskyFunctions && riskyFunctions.length) {
    return `<span class="badge badge-red">${riskyFunctions.join(", ")}</span>`;
  }
  return `<span class="badge badge-green">No risky fns</span>`;
}

function holdingBadge(pct) {
  if (pct === null || pct === undefined) return `<span class="badge badge-gray">Deployer: unknown</span>`;
  let cls = "badge-green";
  if (pct >= 20) cls = "badge-red";
  else if (pct >= 5) cls = "badge-amber";
  return `<span class="badge ${cls}">Deployer: ${pct.toFixed(1)}%</span>`;
}

function renderCard(t) {
  return `
    <div class="token-card ${t.isSafu ? "is-safu" : ""}">
      <div class="card-top">
        <span><span class="token-name">${t.name}</span><span class="token-symbol">${t.symbol}</span></span>
        <span class="token-liq">${t.baseLiquidity.toFixed(3)} ${t.baseSymbol}</span>
      </div>
      <div class="card-stats-row">
        <span class="stat-item">MC <strong>${formatCompactUsd(t.marketCapUsd)}</strong></span>
        <span class="stat-item">Price <strong>${formatCompactUsd(t.priceUsd)}</strong></span>
      </div>
      <div class="card-addr-row">
        <span class="token-addr">${t.tokenAddress}</span>
        <button class="copy-btn" data-addr="${t.tokenAddress}">Copy CA</button>
      </div>
      <div class="card-badges">
        ${verifiedBadge(t.verified)}
        ${riskyBadge(t.riskyFunctions)}
        ${holdingBadge(t.creatorHoldingPct)}
        ${lpBadge(t.lpLockStatus)}
      </div>
      ${t.lpOwner ? `
      <div class="lp-owner-row">
        LP holder: <a href="${EXPLORER_BASE}${t.lpOwner}" target="_blank" rel="noopener">${t.lpOwner.slice(0,6)}…${t.lpOwner.slice(-4)}</a>
        <span class="lp-owner-hint">— check if this is a wallet or a locker contract</span>
      </div>` : ""}
      <div class="card-links">
        <a href="${EXPLORER_BASE}${t.tokenAddress}" target="_blank" rel="noopener">Explorer</a>
        <a href="https://app.uniswap.org/explore/pools/robinhoodchain/${t.poolAddress}" target="_blank" rel="noopener">Pool</a>
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

  const allList = document.getElementById("allList");
  const safuList = document.getElementById("safuList");
  const allEmpty = document.getElementById("allEmpty");
  const safuEmpty = document.getElementById("safuEmpty");

  const safuTokens = tokens.filter((t) => t.isSafu);

  document.getElementById("allCount").textContent = tokens.length;
  document.getElementById("safuCount").textContent = safuTokens.length;

  allEmpty.style.display = tokens.length ? "none" : "block";
  safuEmpty.style.display = safuTokens.length ? "none" : "block";

  allList.innerHTML = tokens.map(renderCard).join("");
  safuList.innerHTML = safuTokens.map(renderCard).join("");

  attachCopyHandlers(allList);
  attachCopyHandlers(safuList);

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

loadTokens({ scanFirst: true });
setInterval(() => loadTokens({ scanFirst: false }), 60 * 1000);
