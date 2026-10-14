// Candidate topics from good_articles.json, and their Wikipedia articles and photos.
const { log } = require('./log');
const goodArticles = require('./good_articles.json'); // [{ name, url, obscurity: 1 (famous) to 5 (obscure), tags }]

const UA = 'DeanMachine/1.0 (Discord bot; https://github.com/deacaldw/dean-machine)';
const OBSCURITY = [2, 3, 4]; // famous enough to guess, not so famous it's too easy
const MAX_TEXT = 20000; // characters of article text kept for the AI
const MIN_TEXT = 3000; // skip stubs
const TIMEOUT_MS = 10000; // per request

const pool = goodArticles.filter(a => OBSCURITY.includes(a.obscurity));

async function api(params) {
  const url = 'https://en.wikipedia.org/w/api.php?' + new URLSearchParams({ format: 'json', formatversion: 2, ...params });
  const started = Date.now();
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    log('Wikipedia', `${params.generator ?? params.action} ${params.titles}`, `failed: ${err.message}`, started);
    throw err;
  }
  log('Wikipedia', `${params.generator ?? params.action} ${params.titles}`, `HTTP ${res.status}`, started);
  if (!res.ok) throw new Error(`Wikipedia returned ${res.status}`);
  return res.json();
}

const candidate = a => ({ name: a.name, title: decodeURIComponent(a.url.split('/wiki/')[1]).replace(/_/g, ' '), obscurity: a.obscurity });

// Every category tag in the pool, sorted.
const tags = () => [...new Set(pool.flatMap(a => a.tags ?? []))].sort();

// All candidates with any of these tags: [{ name, title, obscurity }]
const tagged = wanted => pool.filter(a => (a.tags ?? []).some(tag => wanted.includes(tag))).map(candidate);

// Full text, image and URL of an article, or null if it's a stub, list or disambiguation page.
async function article(title) {
  const data = await api({
    action: 'query', redirects: 1, titles: title,
    prop: 'extracts|pageimages|info|pageprops',
    explaintext: 1, piprop: 'thumbnail', pithumbsize: 800, inprop: 'url',
    ppprop: 'disambiguation',
  });
  const page = data.query?.pages?.[0];
  if (!page || page.missing || page.pageprops?.disambiguation !== undefined) return null;
  if (/^(List|Lists|Index|Outline|Timeline) of /i.test(page.title) || (page.extract ?? '').length < MIN_TEXT) return null;
  return {
    title: page.title,
    url: page.fullurl,
    image: page.thumbnail?.source ?? null,
    text: page.extract.slice(0, MAX_TEXT),
  };
}

// URLs of up to `max` photos from an article, its main image first. Icons and logos (SVGs) are skipped.
async function photos(article, max = 5) {
  const data = await api({
    action: 'query', generator: 'images', titles: article.title, gimlimit: 50,
    prop: 'imageinfo', iiprop: 'url|mime', iiurlwidth: 800,
  });
  const found = (data.query?.pages ?? [])
    .map(p => p.imageinfo?.[0])
    .filter(info => /^image\/(jpeg|png|gif)$/.test(info?.mime ?? ''))
    .map(info => info.thumburl ?? info.url);
  const fileOf = url => decodeURIComponent(url.split('?')[0].split('/').pop()).replace(/^\d+px-/, '');
  const main = article.image ? [article.image] : [];
  return [...main, ...found.filter(url => !main.some(m => fileOf(m) === fileOf(url)))].slice(0, max);
}

module.exports = { tags, tagged, article, photos, pool };
