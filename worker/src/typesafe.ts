/**
 * Cut the Noise — TypeSafe (Jev) client.
 *
 * One request per post: five Score questions batched together.
 * Answers are normalized to 0..1 (score / top level) so the extension's
 * weights mean the same thing on every dimension.
 */
import { DIMENSIONS, DimName, QUESTIONS, buildState } from './questions';

const API_URL = 'https://api.typesafe.ai/v1/systemone';
const MODEL = 'jev-latest';
const MAX_ATTEMPTS = 3;

export interface DimAnswer {
  /** normalized 0..1 */
  score: number;
  /** 0..1, distribution concentration */
  confidence: number;
}

export type DimScores = Record<DimName, DimAnswer>;

interface JevAnswer {
  score?: number;
  confidence?: number;
  legend?: Record<string, unknown>;
}

interface JevResponse {
  answers?: Record<string, JevAnswer>;
}

async function fetchWithRetry(
  apiKey: string,
  body: unknown,
  signal?: AbortSignal
): Promise<Response> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const backoff = 500 * Math.pow(2, attempt - 1) + Math.random() * 250;
      await new Promise((r) => setTimeout(r, backoff));
    }
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(body),
        signal
      });
      // 429 rate limit and 529 overload are retryable; other 4xx are not.
      if (res.status === 429 || res.status === 529 || res.status >= 500) {
        lastError = new Error(`typesafe_${res.status}`);
        continue;
      }
      return res;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('typesafe_retry_exhausted');
}

export async function scorePost(
  apiKey: string,
  text: string,
  interests: string
): Promise<DimScores> {
  const body = {
    state: buildState(text, interests),
    model: MODEL,
    questions: QUESTIONS
  };

  const res = await fetchWithRetry(apiKey, body);
  if (!res.ok) {
    throw new Error(`typesafe_${res.status}`);
  }
  const data = (await res.json()) as JevResponse;
  const answers = data.answers ?? {};

  const out: Partial<DimScores> = {};
  for (const dim of DIMENSIONS) {
    const a = answers[dim];
    if (!a || typeof a.score !== 'number') {
      throw new Error(`missing_answer_${dim}`);
    }
    // Normalize: score runs 0..(levels-1); use the returned legend when
    // present, else the rubric's own level count.
    const levels = a.legend
      ? Object.keys(a.legend).length
      : QUESTIONS[dim].criteria.length;
    const top = Math.max(1, levels - 1);
    out[dim] = {
      score: Math.min(1, Math.max(0, a.score / top)),
      confidence: typeof a.confidence === 'number' ? a.confidence : 0
    };
  }
  return out as DimScores;
}
