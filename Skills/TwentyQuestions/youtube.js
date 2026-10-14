// YouTube videos for the end of a game, from the official YouTube Data API v3. Needs YOUTUBE_API_KEY; without it,
// or on any failure, there's simply no video.
const { log } = require('./log');

const TIMEOUT_MS = 15000; // a slow or stuck YouTube never holds up the end of a game

// YouTube titles come HTML-encoded ("Rock &amp; Roll"); brackets would break a [title](url) link.
const plainTitle = title => title
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/[[\]]/g, '').trim();

// The top safe-search video for a search as { title, url }, or null if there's none or anything goes wrong.
async function search(query) {
  if (!process.env.YOUTUBE_API_KEY || !query) return null;
  const started = Date.now();
  try {
    const params = new URLSearchParams({ part: 'snippet', type: 'video', maxResults: 1, safeSearch: 'strict', q: query, key: process.env.YOUTUBE_API_KEY });
    const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    // Google explains a refusal in the body (like a key restriction), so pass that on.
    if (!res.ok) throw new Error(`YouTube returned ${res.status}: ${(await res.json().catch(() => null))?.error?.message ?? 'no details'}`);
    const [video] = (await res.json()).items ?? [];
    log('YouTube', query, video ? video.snippet.title : 'no results', started);
    return video ? { title: plainTitle(video.snippet.title), url: `https://www.youtube.com/watch?v=${video.id.videoId}` } : null;
  } catch (err) {
    log('YouTube', query, `failed: ${err.message}`, started);
    console.error(`TwentyQuestions: no video: ${err.message}`);
    return null;
  }
}

module.exports = { search, plainTitle };
