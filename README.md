# jev-x — cut the noise on your X timeline with Jev

A browser extension that turns your X (Twitter) feed into an adjustable view:
more firsthand experience, fewer sales pitches and recycled takes. [Jev](https://docs.typesafe.ai)
(TypeSafe's System One model) scores each post once on independent dimensions —
concrete firsthand experience, promotional intent, engagement bait, technical
depth, relevance — and **your sliders** decide what happens to each post.
No summaries, no reordering: posts are dimmed or collapsed in place, always
reversible.

You define what "good content" means instead of accepting the platform's ranking.

## What it does

- Scores posts on the **home timeline and lists** (`x.com/home`, `x.com/i/lists`).
  DMs, notifications, profiles, and search are never read — which keeps DMs and
  protected-account content out of scope by construction.
- **Dim or collapse in place.** Nothing is removed from the DOM, nothing is
  reordered. Every collapsed post has a **Show anyway** button.
- **Cautious defaults.** Posts with no extractable text (image/video-only) are
  left alone; posts scored with low confidence are never collapsed — text-only
  classification shouldn't aggressively hide what it can't confidently judge.
- **Debug mode.** Toggle "Show scores instead of filtering" and each scored post
  gets a compact score strip *under* the post: per-dimension percentages, the
  net score, and the action that would have been taken. Filtering is suppressed
  while it's on; hover a strip for full JSON (per-dimension score + confidence).
- **Score caching.** Raw dimension scores are cached in the worker's KV
  (30-day TTL, keyed by a hash of rubric + text + interests) and client-side —
  repeat posts across sessions cost nothing.
- **Sliders never trigger re-scoring.** The weighted decision is recomputed
  client-side from cached raw scores; changes apply instantly.

## How it works

```
┌─────────────────────┐   batches of    ┌──────────────────────┐
│  content script      │  ≤12 posts      │  Cloudflare Worker   │
│  (x.com pages)       │ ──────────────► │                      │
│  extract · dim ·     │                 │  KV cache (30d TTL)  │
│  collapse · scores   ◄───────────────  │  sha256(text+interests)
└──────────┬──────────┘  scores/key      │        │ miss        │
           │                            │        ▼             │
           │ chrome.storage.session     │  Jev (TypeSafe       │
           │ (client-side cache)        │  System One):        │
           ▼                            │  5 Score questions   │
┌─────────────────────┐                 │  in one request      │
│  background SW      │                 └──────────────────────┘
│  (network, de-dupe) │
└─────────────────────┘
```

- The extension extracts post text and author handle in the browser. Only text
  (≤640 chars, truncated server-side at 1000) is sent for scoring. Handles are
  used client-side for the allowlist and are **not** sent to Jev.
- The Worker holds the TypeSafe API key and a shared token, so neither ever
  reaches the page context.

## The rubric

Each post gets five Jev Score questions in one request (see
`worker/src/questions.ts`), each with four concrete, situation-based levels.
Scores are normalized to 0–1; the extension combines them:

```
net = Σ (slider_dim / 3) × score_dim        slider ∈ [-3..3]
net ≤ -0.30   → dim
net ≤ -0.90   → collapse  (never when min confidence < 0.30)
```

Default sliders: firsthand +2, depth +1, relevance +2, promo −3, bait −3.

## Repo layout

```
extension/                unpacked Chrome extension (MV3)
  lib/composition.js        slider math + decision thresholds (unit-tested)
  lib/composition.test.js   node:test suite for the decision logic
  content/content.js        extraction, batching, dim/collapse UI, score strips
  content/content.css       dim/collapse/score-strip styles
  popup/                    settings UI (backend, interests, sliders, allowlist)
  background.js             service worker: network + de-dupe
worker/                  Cloudflare Worker: Jev proxy + KV cache + token gate
  src/questions.ts          the five Jev Score questions (the rubric)
  src/index.ts              batching, cache, TypeSafe calls
  src/cache.ts, typesafe.ts cache helpers + TypeSafe client
  scripts/rubric-check.mjs  live rubric smoke test (npm run smoke)
```

## Setup

### 1. Worker (your own deployment)

```sh
cd worker
npm install
npx wrangler kv namespace create cut-the-noise-SCORES   # put the id in wrangler.jsonc
npx wrangler types && npm run check
npx wrangler secret put TYPESAFE_API_KEY               # from docs.typesafe.ai
npx wrangler secret put WORKER_TOKEN                   # e.g. openssl rand -hex 32
npm run deploy
```

Rubric sanity check against your deployment (cached posts cost nothing):

```sh
CTN_BASE_URL=<your-worker-url> WORKER_TOKEN=<token> npm run smoke
```

For local dev instead: copy `worker/.dev.vars.example` to `worker/.dev.vars`,
fill in the values, and run `npm run dev`.

### 2. Extension

```sh
# Chrome: chrome://extensions → enable Developer mode → Load unpacked
# → select the extension/ directory
```

Open the popup (puzzle icon → Cut the Noise):

1. **Backend**: your Worker URL plus the `WORKER_TOKEN` value. "Test connection"
   requests the host permission and pings `/v1/ping` — which validates the token
   (a mismatch shows as "Token rejected"). It should report
   "OK — token valid, Jev ready".
2. **Your interests**: one or two sentences; feeds the relevance dimension.
3. **Sliders**: −3 (suppress) … 0 (ignore) … +3 (boost). Changes apply to
   already-scored posts instantly.
4. **Always show these authors**: allowlist, one handle per line. Never scored.
5. Toggle **Enabled**, whether bad posts get collapsed or only dimmed, and the
   **Show scores** debug mode described above.

## Testing

```sh
node --test extension/lib/composition.test.js   # scoring/decision unit tests
cd worker && npm run check                      # worker type check
cd worker && CTN_BASE_URL=<worker-url> WORKER_TOKEN=<t> npm run smoke   # live rubric check
```

## Privacy disclosure (also shown in the popup)

While filtering is enabled, the text of posts on your home timeline and lists
is sent to your backend and to TypeSafe (Jev) for scoring. Images, videos, and
thread context are not included. DMs, notifications, profiles, and search are
not read. Scores are cached so repeat posts are not re-scored. The extension
does not detect "AI slop" or truthfulness — only the dimensions you see
sliders for.

## Known limitations (honest ones)

- **X terms of service.** This extension reads X page content in your own
  logged-in browser. X's terms prohibit scraping without written permission;
  "it only reads posts you've already loaded" is not a guaranteed exemption.
  Review X's current policies before any distribution beyond yourself. This
  code is a personal-use prototype.
- **DOM maintenance.** X changes markup regularly; if extraction silently
  stops, update `SELECTORS` in `extension/content/content.js`. Failure mode is
  "posts left alone," never "posts mangled."
- **Text-only classification.** Image jokes, video, and thread context are
  invisible to the rubric. Uncertain posts are left alone (or at most dimmed),
  per the design rule above.
- **"Show anyway" overrides** currently last for the page session; a reload
  re-applies filtering. Persisting overrides is a trivial follow-up.
- **Relevance + cache key.** Interests are part of the cache key, so editing
  them re-scores your feed once.

## License

MIT — see [LICENSE](LICENSE).
