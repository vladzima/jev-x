/*
 * Cut the Noise — background service worker.
 *
 * Owns all network I/O. The content script never fetches directly; it sends
 * batches of posts here. Responsibilities:
 *  - de-duplicate against an in-memory cache, persisted to
 *    chrome.storage.session so it survives service-worker restarts
 *  - forward misses to the Cut-the-Noise Worker (which calls Jev and keeps
 *    the shared KV cache)
 *  - keep the backend URL/token (chrome.storage.local, user-private) and
 *    never expose them to page content
 */

const CACHE_KEY = 'ctn_score_cache';
const CACHE_LIMIT = 2000;

/** @type {Map<string, Object<string, {score:number, confidence:number}>>} key -> dims */
let scoreCache = new Map();
let cacheLoaded = false;
let cacheSaveTimer = null;

async function ensureCacheLoaded() {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const stored = await chrome.storage.session.get(CACHE_KEY);
    const raw = stored && stored[CACHE_KEY];
    if (raw && typeof raw === 'object') {
      scoreCache = new Map(Object.entries(raw));
    }
  } catch (_) {
    // session storage unavailable (older Chrome): fall back to memory-only
  }
}

function scheduleCacheSave() {
  if (cacheSaveTimer) return;
  cacheSaveTimer = setTimeout(async () => {
    cacheSaveTimer = null;
    try {
      const entries = [...scoreCache.entries()].slice(-CACHE_LIMIT);
      await chrome.storage.session.set({ [CACHE_KEY]: Object.fromEntries(entries) });
    } catch (_) {
      // non-fatal
    }
  }, 2000);
}

async function backendConfig() {
  const stored = await chrome.storage.local.get(['backendUrl', 'backendToken']);
  return {
    url: (stored.backendUrl || '').replace(/\/+$/, ''),
    token: stored.backendToken || ''
  };
}

/**
 * Score a batch of posts.
 * @param {{key:string, text:string}[]} posts
 * @param {string} interests
 * @returns {Promise<{scores:Object<string,Object>, error:string|null}>}
 */
async function handleScoreBatch(posts, interests) {
  await ensureCacheLoaded();

  const scores = {};
  const misses = [];
  for (const p of posts) {
    const hit = scoreCache.get(p.key);
    if (hit) scores[p.key] = hit;
    else misses.push(p);
  }
  if (misses.length === 0) return { scores, error: null };

  const cfg = await backendConfig();
  if (!cfg.url) {
    return { scores, error: 'no_backend' };
  }

  try {
    const res = await fetch(cfg.url + '/v1/scores', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-token': cfg.token
      },
      body: JSON.stringify({ posts: misses, interests: String(interests || '') })
    });
    if (!res.ok) {
      return { scores, error: 'backend_' + res.status };
    }
    const data = await res.json();
    const fresh = (data && data.scores) || {};
    for (const [key, dims] of Object.entries(fresh)) {
      if (!dims) continue;
      scoreCache.set(key, dims);
      scores[key] = dims;
    }
    scheduleCacheSave();
    return { scores, error: null };
  } catch (e) {
    return { scores, error: 'network' };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.type === 'CTN_SCORE') {
    handleScoreBatch(msg.posts || [], msg.interests || '').then(sendResponse);
    return true; // async response
  }
  return false;
});
