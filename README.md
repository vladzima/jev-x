# jev-x

**Cut the noise on your X timeline with [Jev](https://docs.typesafe.ai).**

A personal-use Chrome extension that scores posts on five dimensions and lets
**your sliders** decide what stays visible, gets dimmed, or gets collapsed.
No summaries. No reordering. Every collapsed post has a **Show anyway** button.

The extension appears in Chrome as **Cut the Noise**.

## Why Jev?

Jev, TypeSafe's System One model, supplies small, typed judgments rather than
writing a response. This project asks five independent Score questions per post
in one request, caches the results, and combines them in ordinary JavaScript.
Changing a slider changes the decision immediately, without another model call.

| Dimension | What it measures | Default weight |
| --- | --- | --- |
| Firsthand experience | Specific experience, concrete details, lessons learned | +2 |
| Self-promotion | Selling, product plugs, audience-growth pitches | -3 |
| Engagement bait | Rage bait, cliffhangers, engagement-farming mechanics | -3 |
| Technical depth | Mechanisms, code, architecture, technical trade-offs | +1 |
| Relevance | Fit with the interests you enter | +2 |

The rubric lives in [`worker/src/questions.ts`](worker/src/questions.ts).
These are content judgments, not fact-checks or an "AI slop" detector.

## How it behaves

- Runs on X's **home timeline and lists**. It does not process DMs,
  notifications, profiles, or search pages.
- Dims or collapses posts in place. Hover a dimmed post to peek; use
  **Show anyway** to reveal a collapsed post for the current page session.
- Leaves posts without extractable text alone. Low-confidence results are
  never collapsed, though they can still be dimmed.
- An author allowlist skips scoring and filtering for newly scanned posts.
- **Show Jev scores under each post** switches off dim/collapse and displays
  a compact debug strip below each scored post, without squeezing its width.
  It shows `f`irsthand, `p`romo, `b`ait, `d`epth, `r`elevance, the weighted net
  score, and the proposed action. Hover for score/confidence JSON.

### Decision rule

```text
net = sum((slider / 3) * dimension_score)

sliders: -3 to +3       dimension scores: 0 to 1
net <= -0.30: dim
net <= -0.90: collapse, unless minimum confidence across used dimensions < 0.30
```

Zero-weight dimensions are ignored. These thresholds are prototype defaults,
not guarantees of model accuracy. See
[`extension/lib/composition.js`](extension/lib/composition.js).

## Architecture

```text
X home/list page
  -> content script: extract text, batch posts, apply display decisions
  -> extension background worker: session cache, authenticated requests
  -> Cloudflare Worker: token check, KV cache, bounded concurrency
  -> Jev: five Score questions per post
  <- raw dimension scores, combined locally with your slider weights
```

The extension sends up to 12 posts per batch and up to 640 characters per post.
The Worker caps text at 1,000 characters, scores up to four posts concurrently,
and caches scores in KV for 30 days. Its cache key includes the rubric version,
text, and interests. KV values contain scores, not post text.

## Quick start

You need a Chromium browser that supports unpacked extensions, a recent Node.js
release supported by Wrangler, a Cloudflare account, and a TypeSafe API key.
Scoring and hosting use your own accounts and may incur charges.

### 1. Set up the Worker

```sh
git clone https://github.com/vladzima/jev-x.git
cd jev-x/worker
npm ci
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` with your TypeSafe API key and a random shared `WORKER_TOKEN`
(for example, generate one with `openssl rand -hex 32`). Never commit this file.

For local development:

```sh
npm run types
npm run check
npm run dev
```

For a deployed backend:

```sh
npx wrangler login
npx wrangler kv namespace create cut-the-noise-SCORES
```

Replace the `SCORES` namespace ID in `wrangler.jsonc` with the ID from that
command. The checked-in ID belongs to the original deployment; use your own.
Then set production secrets and deploy:

```sh
npx wrangler secret put TYPESAFE_API_KEY
npx wrangler secret put WORKER_TOKEN
npm run deploy
```

Use the same shared token in the extension. `.dev.vars` is for local development;
it is not a substitute for setting production secrets.

### 2. Load the extension

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked**, then select the repository's `extension/` directory.
3. Open the **Cut the Noise** popup.
4. Enter your Worker URL (or `http://localhost:8787`) and shared token.
   Click **Test connection** and grant permission for that backend origin.
5. Enter your interests, adjust the sliders, and open or refresh your X home feed.

There is no extension build step. After changing extension code, reload it in
`chrome://extensions` and refresh the X tab.

## Development and tests

```sh
# From the repository root:
node --test extension/lib/composition.test.js

# Worker type check, after installing dependencies and creating .dev.vars:
cd worker
npm run types
npm run check

# Optional live rubric check; reads WORKER_TOKEN from your environment:
CTN_BASE_URL=http://localhost:8787 npm run smoke
```

The smoke script prints scores for sample posts. It is a rubric exploration
tool, not an automated pass/fail test, and uncached calls use your API quota.

```text
extension/
  background.js          Backend requests and session score cache
  content/               Post extraction, dim/collapse UI, debug score strips
  lib/                   Scoring composition and its unit tests
  popup/                 Settings, sliders, allowlist, connection test
worker/
  src/questions.ts       Five Score questions and model input state
  src/typesafe.ts        Jev client, retries, score normalization
  src/cache.ts           KV cache keys and envelopes
  src/index.ts           HTTP routes, authentication, batching
  scripts/               Live rubric check
```

For troubleshooting, turn on **Debug logging** and filter the X tab's console
for `[ctn]`. `__ctnDebug()` is available in the extension's content-script
execution context, not necessarily the page's default console context.

## Privacy and limitations

- **Text leaves your browser.** While enabled, extracted post text and your
  interests go to your Worker and, on a cache miss, to TypeSafe. Author handles
  are used locally for the allowlist and are not separately sent for scoring.
  Handles or personal details contained in post text can still be transmitted.
- **Protected posts are not detected.** A protected-account post visible on
  your home timeline or a list may be processed. Page-level scope is not a
  public-content-only guarantee.
- **Text only.** Images, video, replies, and full thread context are not analyzed.
  Posts with no extractable text are skipped; long text is truncated.
- **Cache invalidation is incomplete.** The Worker key includes interests,
  but browser caches currently key by post, not interests. Changing interests
  can reuse stale relevance scores until those caches are cleared. Slider
  changes correctly reuse scores, but an already-visible debug strip can show
  its previous net/action until rebuilt.
- **DOM integration is experimental.** X markup changes can break extraction
  or display behavior. Selectors live in `extension/content/content.js`.
  Refresh after allowlist changes to ensure existing posts are rescanned.
- **Personal-use prototype.** Review X's current terms and automation policies
  before using or distributing it. Running inside your own browser does not
  establish permission from X.
