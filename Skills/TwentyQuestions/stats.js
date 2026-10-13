// Counts work done on behalf of one game (Wikipedia lookups, AI calls), even when several games start at once.
const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();

// Runs fn; everything it does (including awaited calls) is counted into `counts`.
const track = (counts, fn) => storage.run(counts, fn);

// Adds one to `key` for the game currently being tracked, if any.
function count(key) {
  const counts = storage.getStore();
  if (counts) counts[key] = (counts[key] ?? 0) + 1;
}

module.exports = { track, count };
