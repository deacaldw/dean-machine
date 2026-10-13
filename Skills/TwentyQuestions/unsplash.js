// Topic photos from Unsplash. Needs UNSPLASH_ACCESS_KEY; without it, games simply have no photo.
// Unsplash API terms: hotlink their image URLs, credit the photographer, and report each photo used.
const REFERRAL = 'utm_source=deanmachine&utm_medium=referral';
const HOME = `https://unsplash.com/?${REFERRAL}`;

const headers = () => ({ Authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}`, 'Accept-Version': 'v1' });

// The top family-safe landscape photo for a search, or null.
async function search(query) {
  if (!process.env.UNSPLASH_ACCESS_KEY) return null;
  const params = new URLSearchParams({ query, per_page: 1, orientation: 'landscape', content_filter: 'high' });
  const res = await fetch(`https://api.unsplash.com/search/photos?${params}`, { headers: headers() });
  if (!res.ok) throw new Error(`Unsplash returned ${res.status}`);
  const [p] = (await res.json()).results;
  return p ? { url: p.urls.regular, photographer: p.user.name, profile: `${p.user.links.html}?${REFERRAL}`, downloadLocation: p.links.download_location } : null;
}

// Required by Unsplash whenever a photo is shown.
function reportUse(photo) {
  fetch(photo.downloadLocation, { headers: headers() }).catch(() => {});
}

module.exports = { search, reportUse, HOME };
