/**
 * Cut the Noise — Worker entry.
 *
 * POST /v1/scores  { posts: [{key, text}], interests }  →  { scores: { key: dims } }
 * GET  /healthz    liveness + config check
 *
 * The TypeSafe API key and a shared worker token live only here. The
 * extension authenticates with the token in the x-api-token header.
 */
import { cacheKey, envelope, readEnvelope, put } from './cache';
import { DIMENSIONS } from './questions';
import { scorePost, DimScores } from './typesafe';

const MAX_POSTS_PER_REQUEST = 12;
const MAX_TEXT_CHARS = 1000;
const MAX_INTERESTS_CHARS = 300;
const SCORING_CONCURRENCY = 4;

// ---------- helpers ----------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

/** Constant-time-ish token check: hash both sides, compare fixed-length digests. */
async function tokenMatches(expected: string | undefined, provided: string): Promise<boolean> {
  if (!expected) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
    crypto.subtle.digest('SHA-256', enc.encode(provided))
  ]);
  const va = new Uint8Array(a);
  const vb = new Uint8Array(b);
  if (va.length !== vb.length) return false;
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

/** Bounded-concurrency map. Preserves order; failures become null. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<(R | null)[]> {
  const results: (R | null)[] = new Array(items.length).fill(null);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch {
        results[i] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---------- handlers ----------

async function handleScores(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const token = request.headers.get('x-api-token') ?? '';
  if (!(await tokenMatches(env.WORKER_TOKEN, token))) {
    return json({ error: 'unauthorized' }, 401);
  }

  let body: {
    posts?: Array<{ key?: unknown; text?: unknown }>;
    interests?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad_json' }, 400);
  }

  const rawPosts = Array.isArray(body.posts) ? body.posts : [];
  if (rawPosts.length === 0) {
    return json({ error: 'no_posts' }, 400);
  }
  if (rawPosts.length > MAX_POSTS_PER_REQUEST) {
    return json({ error: 'too_many_posts' }, 400);
  }

  const interests =
    typeof body.interests === 'string'
      ? body.interests.slice(0, MAX_INTERESTS_CHARS)
      : '';

  // Validate and truncate; drop anything malformed.
  const posts: Array<{ key: string; text: string }> = [];
  for (const p of rawPosts) {
    if (
      p &&
      typeof p.key === 'string' &&
      p.key.length > 0 &&
      p.key.length <= 64 &&
      typeof p.text === 'string' &&
      p.text.trim().length > 0
    ) {
      posts.push({ key: p.key, text: p.text.slice(0, MAX_TEXT_CHARS) });
    }
  }
  if (posts.length === 0) {
    return json({ error: 'no_valid_posts' }, 400);
  }

  // Cache lookup.
  const keys = await Promise.all(posts.map((p) => cacheKey(p.text, interests)));
  const cached = await Promise.all(keys.map((k) => env.SCORES.get(k)));

  const scores: Record<string, DimScores> = {};
  const misses: Array<{ post: { key: string; text: string }; cacheKey: string }> = [];
  for (let i = 0; i < posts.length; i++) {
    const dims = readEnvelope(cached[i]);
    if (dims) {
      scores[posts[i].key] = dims;
    } else {
      misses.push({ post: posts[i], cacheKey: keys[i] });
    }
  }

  if (misses.length > 0 && env.TYPESAFE_API_KEY) {
    const fresh = await mapLimit(misses, SCORING_CONCURRENCY, async (m) => {
      const dims = await scorePost(env.TYPESAFE_API_KEY, m.post.text, interests);
      return { m, dims };
    });
    for (const item of fresh) {
      if (!item) continue;
      scores[item.m.post.key] = item.dims;
      await put(env.SCORES, item.m.cacheKey, envelope(item.dims, 'jev-latest'), ctx);
    }
  }

  const errors: Record<string, string> = {};
  for (const p of posts) {
    if (!scores[p.key]) errors[p.key] = 'score_unavailable';
  }

  return json({ scores, errors });
}

async function handleHealthz(env: Env): Promise<Response> {
  const hasKey = Boolean(env.TYPESAFE_API_KEY);
  const hasToken = Boolean(env.WORKER_TOKEN);
  return json({
    ok: hasKey && hasToken,
    cache: Boolean(env.SCORES),
    typesafe_key: hasKey,
    worker_token: hasToken
  });
}

/**
 * Token-checked ping. Unlike /healthz (which is unauthenticated liveness),
 * this validates the x-api-token header — it is what the extension's
 * "Test connection" uses, so a bad token fails the test instead of
 * silently failing later during scoring.
 */
async function handlePing(env: Env, request: Request): Promise<Response> {
  const token = request.headers.get('x-api-token') ?? '';
  if (!(await tokenMatches(env.WORKER_TOKEN, token))) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }
  return json({
    ok: true,
    scoring: Boolean(env.TYPESAFE_API_KEY),
    cache: Boolean(env.SCORES)
  });
}

// ---------- entry ----------

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === 'POST' && url.pathname === '/v1/scores') {
        return await handleScores(request, env, ctx);
      }
      if (request.method === 'GET' && url.pathname === '/healthz') {
        return await handleHealthz(env);
      }
      if (request.method === 'GET' && url.pathname === '/v1/ping') {
        return await handlePing(env, request);
      }
      return json({ error: 'not_found' }, 404);
    } catch (e) {
      // Structured error, no internals leaked.
      console.error(
        JSON.stringify({ event: 'handler_error', path: url.pathname })
      );
      return json({ error: 'internal' }, 500);
    }
  }
};
