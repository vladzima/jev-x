#!/usr/bin/env node
/**
 * Rubric sanity check — run against a local `wrangler dev` instance.
 *
 *   1. cd worker && npm run dev        (in another terminal)
 *   2. WORKER_TOKEN=... npm run smoke
 *
 * Sends sample posts spanning the quality space, prints each dimension
 * score and what the extension would do with default sliders. This is for
 * iterating on the rubric wording (worker/src/questions.ts), not a pass/fail
 * test suite.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require('../../extension/lib/composition.js');

const BASE = process.env.CTN_BASE_URL || 'http://127.0.0.1:8787';
const TOKEN = process.env.WORKER_TOKEN || '';
const INTERESTS = process.env.CTN_INTERESTS || 'AI tooling, software engineering, web performance';

const SAMPLES = [
  {
    name: 'firsthand technical',
    text: 'Shipped our edge-rendered docs site last week. LCP went from 3.4s to 0.9s on 4G. The trick was streaming HTML from the Worker and deferring the client bundle — numbers in the thread.'
  },
  {
    name: 'pure ad',
    text: '🚀 My new course "Scale to 100k users" is 40% OFF for the next 24 hours! Link in bio. Retweet to win a free coaching call! 🎁'
  },
  {
    name: 'engagement bait',
    text: 'Hot take: 99% of you are using React wrong. Reply with your stack and I\'ll tell you why it\'s slow. You won\'t believe #3.'
  },
  {
    name: 'recycled take',
    text: 'AI is going to change everything. The companies that adapt will win, the rest will die. Big shift coming.'
  },
  {
    name: 'substantive but promotional',
    text: 'We spent 3 months porting our ingestion pipeline to Rust. P99 latency dropped from 480ms to 60ms. Blog post with the flamegraphs is on our site; happy to answer questions here.'
  },
  {
    name: 'off-topic rage bait',
    text: 'If you still put pineapple on pizza in 2026 you are objectively a psychopath and I will not be taking questions.'
  }
];

function row(name, dims, decision) {
  const s = (d) => `${(d.score * 100).toFixed(0)}%/${(d.confidence * 100).toFixed(0)}c`;
  return (
    name.padEnd(30) +
    ' f=' + s(dims.firsthand) +
    ' p=' + s(dims.promo) +
    ' b=' + s(dims.bait) +
    ' d=' + s(dims.depth) +
    ' r=' + s(dims.relevance) +
    '  → ' + decision.action +
    (decision.reasons.length ? ' (' + decision.reasons.join(' · ') + ')' : '') +
    (decision.uncertain ? ' [uncertain]' : '')
  );
}

async function main() {
  const posts = SAMPLES.map((s, i) => ({
    key: String(i),
    text: s.text
  }));

  const res = await fetch(BASE + '/v1/scores', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-token': TOKEN },
    body: JSON.stringify({ posts, interests: INTERESTS })
  });
  const body = await res.json();
  if (!res.ok) {
    console.error('HTTP', res.status, JSON.stringify(body));
    process.exit(1);
  }

  console.log('interests:', INTERESTS);
  console.log('default sliders:', JSON.stringify(C.DEFAULT_SETTINGS.weights));
  console.log('');
  for (const [i, sample] of SAMPLES.entries()) {
    const dims = body.scores[i];
    if (!dims) {
      console.log(sample.name.padEnd(30), '→ no scores (' + (body.errors && body.errors[i]) + ')');
      continue;
    }
    console.log(row(sample.name, dims, C.decide(dims, C.DEFAULT_SETTINGS)));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
