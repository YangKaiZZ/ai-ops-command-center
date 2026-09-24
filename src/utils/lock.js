// Runs async work one at a time per key, in the order it was queued.
// Used where two things racing would do damage: two syncs double-alerting,
// or two Shopify token refreshes (each refresh invalidates the previous
// refresh token, so the loser would lock the store out).
// In-process only: assumes a single backend instance.
const queues = new Map();

function withLock(key, fn) {
  const run = (queues.get(key) || Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  queues.set(key, tail);
  tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

module.exports = { withLock };
