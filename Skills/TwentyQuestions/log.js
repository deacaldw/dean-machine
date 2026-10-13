// Logs every outside request (AI, Wikipedia) to stdout, one line each. Off for now; set LOGGING to true to see them.
const LOGGING = false;

// "[20Q] Wikipedia query Frog → HTTP 200 (123 ms)". Long values are shortened to one line; `note` isn't.
const short = (value, max = 160) => {
  const text = (typeof value === 'string' ? value : JSON.stringify(value) ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

function log(service, request, result, started, note = '') {
  if (!LOGGING) return;
  console.log(`[20Q] ${service} ${short(request)} → ${short(result)}${note && ` ${note}`} (${Date.now() - started} ms)`);
}

module.exports = { log, short };
