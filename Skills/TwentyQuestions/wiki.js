// Picks a well-known English Wikipedia article from one of three curated sources.
const { count } = require('./stats');
const UA = 'DeanMachine/1.0 (Discord bot; https://github.com/deacaldw/dean-machine)';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MAX_TEXT = 20000; // characters of article text kept for the AI
const MIN_TEXT = 3000; // skip stubs

const random = list => list[Math.floor(Math.random() * list.length)];
const randomInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const lastYear = () => new Date().getUTCFullYear() - 1;

async function api(host, params) {
  const url = `https://${host}/w/api.php?` + new URLSearchParams({ format: 'json', formatversion: 2, ...params });
  count('wikipedia');
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${host} returned ${res.status}`);
  return res.json();
}

const wikitext = async (host, page) =>
  (await api(host, { action: 'parse', prop: 'wikitext', redirects: 1, page })).parse?.wikitext ?? '';

// Bold links mark the featured article in TFA and DYK pages: '''[[Title]]''' or '''[[Title|text]]'''
const boldLinks = text => [...text.matchAll(/'''+\[\[([^\]|#]+)/g)].map(m => m[1].trim());

const sources = {
  async featured() {
    const date = `${random(MONTHS)} ${randomInt(1, 28)}, ${randomInt(2007, lastYear())}`;
    return boldLinks(await wikitext('en.wikipedia.org', `Wikipedia:Today's featured article/${date}`))[0];
  },
  async didYouKnow() {
    const page = `Wikipedia:Did you know archive/${randomInt(2008, lastYear())}/${random(MONTHS)}`;
    return random(boldLinks(await wikitext('en.wikipedia.org', page)));
  },
  async vital() {
    const list = await wikitext('www.wikidata.org', 'Wikidata:List of 1000 articles every Wikipedia should have');
    const id = random([...list.matchAll(/^\| \[\[(Q\d+)\|Q\d+\]\]$/gm)].map(m => m[1]));
    const entity = (await api('www.wikidata.org', { action: 'wbgetentities', ids: id, props: 'sitelinks', sitefilter: 'enwiki' })).entities?.[id];
    return entity?.sitelinks?.enwiki?.title;
  },
};

// Full text, image and URL of an article, or null if it's a stub, list or disambiguation page.
async function article(title) {
  const data = await api('en.wikipedia.org', {
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

// How often each source is drawn. The 1,000-article list is mostly broad concepts (Ship, Number) that
// make easy games, so it's drawn half as often as the others: 1 in 6.
const WEIGHTS = { featured: 5, didYouKnow: 5, vital: 2 };

function randomSource() {
  let roll = Math.random() * Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  for (const [name, weight] of Object.entries(WEIGHTS)) {
    if ((roll -= weight) < 0) return name;
  }
  return 'featured';
}

// A random article from a weighted random source; retries on dead ends.
async function pick(attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    try {
      const title = await sources[randomSource()]();
      const found = title && await article(title);
      if (found) return found;
    } catch {
      // try another source
    }
  }
  throw new Error('No usable Wikipedia article found');
}

module.exports = { pick, article, boldLinks, randomSource, WEIGHTS };
