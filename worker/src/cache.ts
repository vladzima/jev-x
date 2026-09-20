/**
 * Cut the Noise — KV cache for post scores.
 *
 * Key: sha256 of (rubric version, post text, reader interests). Interests are
 * part of the key because the relevance dimension depends on them; changing
 * your interests re-scores rather than serving stale relevance.
 *
 * Values never contain post text — only scores, so the cache itself is not
 * a content store.
 */
import { DIMENSIONS, DimName } from './questions';
import { DimScores } from './typesafe';

const KEY_VERSION = 'ctn1'; // bump when the rubric changes

const TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export async function cacheKey(text: string, interests: string): Promise<string> {
  const normalized = text.trim().toLowerCase();
  const material = `${KEY_VERSION}\u0000${normalized}\u0000${interests.trim().toLowerCase()}`;
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(material)
  );
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return `${KEY_VERSION}:${hex}`;
}

interface CacheEnvelope {
  v: 1;
  dims: DimScores;
  model: string;
  ts: number;
}

export function envelope(dims: DimScores, model: string): CacheEnvelope {
  return { v: 1, dims, model, ts: Date.now() };
}

export function readEnvelope(raw: string | null): DimScores | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CacheEnvelope;
    const dims = parsed && parsed.dims;
    if (!dims) return null;
    for (const dim of DIMENSIONS) {
      const d = dims[dim];
      if (!d || typeof d.score !== 'number' || typeof d.confidence !== 'number') {
        return null;
      }
    }
    return dims;
  } catch {
    return null;
  }
}

export async function put(
  kv: KVNamespace,
  key: string,
  env: CacheEnvelope,
  ctx: ExecutionContext
): Promise<void> {
  // Never block the response on cache writes.
  ctx.waitUntil(kv.put(key, JSON.stringify(env), { expirationTtl: TTL_SECONDS }));
}
