// Generic timeout wrapper for any promise -- lets a slow/hung call fail
// fast instead of blocking whatever is awaiting it forever.
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

// Timeout-guarded JSON fetch. Uses AbortController so the underlying HTTP
// request is actually cancelled, not just abandoned -- a plain Promise.race
// would let the dead request keep running in the background forever.
async function fetchJsonWithTimeout(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    return null; // covers real errors, aborts, and timeouts alike
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { withTimeout, fetchJsonWithTimeout };
