// Topic photos from Unsplash. Needs UNSPLASH_ACCESS_KEY; without it, games simply have no photo.
// Unsplash API terms: hotlink their image URLs, credit the photographer, and report each photo used.
const REFERRAL = 'utm_source=deanmachine&utm_medium=referral';
const HOME = `https://unsplash.com/?${REFERRAL}`;

const headers = () => ({ Authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}`, 'Accept-Version': 'v1' });

async function search(query, count = 4) {
  if (!process.env.UNSPLASH_ACCESS_KEY) return [];
  const params = new URLSearchParams({ query, per_page: count, orientation: 'landscape', content_filter: 'high' });
  const res = await fetch(`https://api.unsplash.com/search/photos?${params}`, { headers: headers() });
  if (!res.ok) throw new Error(`Unsplash returned ${res.status}`);
  return (await res.json()).results.map(p => ({
    url: p.urls.regular,
    preview: p.urls.small, // smaller copy for the AI check
    photographer: p.user.name,
    profile: `${p.user.links.html}?${REFERRAL}`,
    downloadLocation: p.links.download_location,
  }));
}

// Required by Unsplash whenever a photo is shown.
function reportUse(photo) {
  fetch(photo.downloadLocation, { headers: headers() }).catch(() => {});
}

module.exports = { search, reportUse, HOME };
