const config = require("./config");

function formatCompactUsd(value) {
  if (value === null || value === undefined) return "n/a";
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(6)}`;
}

function escapeHtml(str) {
  return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function sendTelegramMessage(text) {
  if (!config.telegramBotToken || !config.telegramChatId) return;
  try {
    const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.telegramChatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("Telegram send failed:", res.status, body);
    }
  } catch (err) {
    console.error("Telegram send error:", err.message);
  }
}

// Design A: score-first summary, then a checklist. Only ever called on
// tokens that already passed isSafu, so every REQUIRED check is a pass by
// definition -- the ✅/➖ distinction here is about honesty, not risk: ➖
// marks a check that was skipped because the data genuinely wasn't
// available on this chain (and so didn't block SAFU), not a hidden failure.
function buildChecklist(record) {
  const lines = [];
  let confirmed = 0;
  let total = 0;

  const add = (label, state) => {
    total += 1;
    if (state === "pass") { confirmed += 1; lines.push(`✅ ${label}`); }
    else if (state === "skip") { lines.push(`➖ ${label}`); }
  };

  add("Verified", record.verified ? "pass" : "skip");
  add("No risky fns", record.riskyFunctions?.length === 0 ? "pass" : "skip");
  add("Not upgradeable", !record.isProxy ? "pass" : "skip");

  if (record.topHolderDataAvailable === false) {
    add(`Top holder: n/a on this chain`, "skip");
  } else {
    add(`Top holder ${record.topHolderPct !== null ? record.topHolderPct.toFixed(1) + "%" : "unknown"}`, "pass");
  }

  add(`LP locked${record.lpLockStatus === "burned" ? " (burned)" : ""}`, "pass");

  if (record.ownershipRenounced === null) {
    add("Ownership: n/a for this contract", "skip");
  } else {
    add("Ownership renounced", "pass");
  }

  if (record.earlySniperPct === null || record.earlySniperPct === undefined) {
    add("Sniping check: unavailable", "skip");
  } else {
    add("No early sniping detected", "pass");
  }

  return { lines, confirmed, total };
}

async function sendSafuAlert(record) {
  const explorerLink = `${record.explorerAddressBase}${record.tokenAddress}`;
  const poolLink = `${record.uniswapPoolUrlBase}${record.poolAddress}`;
  const { lines, confirmed, total } = buildChecklist(record);

  const deployerLine =
    record.deployerLaunches > 1
      ? `Deployer: ${record.deployerLaunches} prior launches, ${record.deployerRuggedCount || 0} flagged rugged`
      : `Deployer: first launch seen`;

  const text =
    `🟢 <b>SAFU · ${confirmed}/${total} checks confirmed</b>\n` +
    `${escapeHtml(record.name)} (${escapeHtml(record.symbol)}) · ${escapeHtml(record.chainLabel)}\n\n` +
    `💰 ${formatCompactUsd(record.marketCapUsd)} MC  ·  ${formatCompactUsd(record.priceUsd)}  ·  ${record.baseLiquidity.toFixed(3)} ${record.baseSymbol} liquidity\n\n` +
    lines.join("\n") + "\n\n" +
    `${deployerLine}\n\n` +
    `<code>${record.tokenAddress}</code>\n\n` +
    `<a href="${explorerLink}">Explorer</a> · <a href="${poolLink}">Pool</a>\n\n` +
    `⚠️ Heuristic signals only, not a guarantee. DYOR.`;

  await sendTelegramMessage(text);
}

module.exports = { sendTelegramMessage, sendSafuAlert };
