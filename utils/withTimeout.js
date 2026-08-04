function withTimeout(promise, ms, label = "operation") {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Timeout-guarded JSON fetch with built-in retry/backoff specifically for
// rate-limiting (HTTP 429). Explorer APIs (Blockscout/Etherscan) rate-limit
// fairly readily, and a single 429 should never be treated the same as
// "this contract really isn't verified" -- that's a false negative, not a
// real answer.
//
// Returns:
//   - parsed JSON on success
//   - null on a genuine non-2xx response (not 429) or a request/parse failure
//   - { __rateLimited: true } if every retry was exhausted while still 429'd
async function fetchJsonWithTimeout(url, { timeoutMs = 8000, retries = 1, retryBaseDelayMs = 1000 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);

      if (res.status === 429) {
        if (attempt < retries) {
          await sleep(retryBaseDelayMs * Math.pow(2, attempt));
          continue;
        }
        return { __rateLimited: true };
      }

      if (!res.ok) return null;
      return await res.json();
    } catch (err) {
      clearTimeout(timer);
      if (attempt < retries) {
        await sleep(retryBaseDelayMs * Math.pow(2, attempt));
        continue;
      }
      return null;
    }
  }
  return null;
}

module.exports = { withTimeout, fetchJsonWithTimeout };
