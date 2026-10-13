// Counts work done on behalf of one game (Wikipedia lookups, AI calls), even when several games start at once,
// and logs every outside request to stdout.
const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();

// Runs fn; everything it does (including awaited calls) is counted into `counts`.
const track = (counts, fn) => storage.run(counts, fn);

// Adds one to `key` for the game currently being tracked, if any.
function count(key) {
  const counts = storage.getStore();
  if (counts) counts[key] = (counts[key] ?? 0) + 1;
}

// One line per request: "[20Q] Wikipedia parse ... → ... (123 ms)". Long values are shortened; `note` isn't.
const short = (value, max = 160) => {
  const text = (typeof value === 'string' ? value : JSON.stringify(value) ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
const log = (service, request, result, started, note = '') =>
  console.log(`[20Q] ${service} ${short(request)} → ${short(result)}${note && ` ${note}`} (${Date.now() - started} ms)`);

module.exports = { track, count, log, short };
