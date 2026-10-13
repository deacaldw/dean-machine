// Random GIFs from GIPHY. Needs GIPHY_API_KEY; without it, there are simply no GIFs.
const RESULTS = 25; // pick at random from this many top results

// URL of a random family-friendly GIF for a search, or null.
async function random(query) {
  if (!process.env.GIPHY_API_KEY) return null;
  const params = new URLSearchParams({ api_key: process.env.GIPHY_API_KEY, q: query, limit: RESULTS, rating: 'g', lang: 'en' });
  const res = await fetch(`https://api.giphy.com/v1/gifs/search?${params}`);
  if (!res.ok) throw new Error(`GIPHY returned ${res.status}`);
  const { data } = await res.json();
  const gif = data[Math.floor(Math.random() * data.length)];
  return gif?.images?.downsized?.url ?? gif?.images?.original?.url ?? null;
}

module.exports = { random };
