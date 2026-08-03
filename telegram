const config = require("./config");

function formatCompactUsd(value) {
  if (value === null || value === undefined) return "n/a";
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(6)}`;
}

async function sendTelegramMessage(text) {
  if (!config.telegramBotToken || !config.telegramChatId) {
    return; // Telegram isn't configured -- skip silently.
  }
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

async function sendSafuAlert(record) {
  const explorerLink = `${record.explorerAddressBase}${record.tokenAddress}`;
  const poolLink = `${record.uniswapPoolUrlBase}${record.poolAddress}`;

  const text =
    `🟢 <b>SAFU: ${escapeHtml(record.name)} (${escapeHtml(record.symbol)})</b>\n` +
    `Chain: ${escapeHtml(record.chainLabel)}\n` +
    `MC: ${formatCompactUsd(record.marketCapUsd)}  ·  Price: ${formatCompactUsd(record.priceUsd)}\n` +
    `Liquidity: ${record.baseLiquidity.toFixed(3)} ${record.baseSymbol}\n` +
    `Top holder: ${record.topHolderPct !== null ? record.topHolderPct.toFixed(1) + "%" : "n/a"}  ·  LP: ${record.lpLockStatus}\n\n` +
    `<code>${record.tokenAddress}</code>\n\n` +
    `<a href="${explorerLink}">Explorer</a> · <a href="${poolLink}">Pool</a>\n\n` +
    `⚠️ Heuristic signals only, not a guarantee. DYOR.`;

  await sendTelegramMessage(text);
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

module.exports = { sendTelegramMessage, sendSafuAlert };
