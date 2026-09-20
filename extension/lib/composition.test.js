/*
 * Tests for the composite scoring module.
 * Run:  node --test extension/lib/composition.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const C = require('./composition.js');

const D = (score, confidence = 0.9) => ({ score, confidence });

function dims({ f = 0, p = 0, b = 0, d = 0, r = 0, conf = 0.9 } = {}) {
  return {
    firsthand: D(f, conf),
    promo: D(p, conf),
    bait: D(b, conf),
    depth: D(d, conf),
    relevance: D(r, conf)
  };
}

const settings = (weights, collapseMode = true) => ({
  ...C.DEFAULT_SETTINGS,
  collapseMode,
  weights: { ...C.DEFAULT_SETTINGS.weights, ...weights }
});

test('pure ad gets collapsed', () => {
  const s = dims({ p: 1, b: 0.95 }); // promo + bait maxed, nothing else
  const out = C.decide(s, settings({}));
  assert.equal(out.action, 'collapse');
});

test('rich firsthand technical post is left alone', () => {
  const s = dims({ f: 1, d: 0.9, r: 1, p: 0, b: 0 });
  const out = C.decide(s, settings({}));
  assert.equal(out.action, 'none');
  assert.ok(out.net > 0);
});

test('moderately promotional post gets dimmed, not collapsed', () => {
  // Some substance, but promo is the dominant signal: dim territory,
  // not collapse-worthy.
  const s = dims({ f: 0.5, p: 0.75, b: 0.4, d: 0.4, r: 0.4 });
  const out = C.decide(s, settings({}));
  assert.equal(out.action, 'dim');
});

test('borderline posts just above the dim threshold are left alone', () => {
  const s = dims({ f: 0.5, p: 0.75, b: 0.2, d: 0.5, r: 0.5 });
  const out = C.decide(s, settings({}));
  assert.equal(out.action, 'none');
});

test('uncertain scores never collapse', () => {
  // Strong promo+bait signals, but low confidence: dim at most.
  const s = dims({ p: 1, b: 1, conf: 0.2 });
  const out = C.decide(s, settings({}));
  assert.ok(out.uncertain);
  assert.notEqual(out.action, 'collapse');
});

test('collapse demoted to dim when collapseMode is off', () => {
  const s = dims({ p: 1, b: 0.95 });
  const out = C.decide(s, settings({}, false));
  assert.equal(out.action, 'dim');
});

test('all sliders at zero means no-op', () => {
  const s = dims({ p: 1, b: 1 });
  const out = C.decide(s, settings({ firsthand: 0, depth: 0, relevance: 0, promo: 0, bait: 0 }));
  assert.equal(out.action, 'none');
  assert.equal(out.net, null);
});

test('missing score for a used dimension means leave alone', () => {
  const s = dims({ p: 1 });
  delete s.bait;
  const out = C.decide(s, settings({}));
  assert.equal(out.action, 'none');
  assert.equal(out.net, null);
});

test('zero-weight dimensions are ignored, missing ones tolerated', () => {
  const s = dims({ p: 1 });
  delete s.bait; // bait slider is off in these settings, so absence is fine
  const out = C.decide(s, settings({ bait: 0 }));
  assert.notEqual(out.net, null);
});

test('weights are clamped to [-3, 3]', () => {
  assert.equal(C.clamp(99), 3);
  assert.equal(C.clamp(-99), -3);
  assert.equal(C.clamp('x'), 0);
});

test('reasons surface the top negative contributors', () => {
  const s = dims({ p: 1, b: 0.8, r: 0.1 });
  const out = C.decide(s, settings({}));
  assert.ok(out.reasons.length >= 1);
  assert.ok(out.reasons[0].startsWith('promo'));
});

test('slider changes do not need rescoring: decide is pure over scores', () => {
  const s = dims({ p: 0.9, b: 0.4 });
  const collapsed = C.decide(s, settings({ promo: -3, bait: -3 }));
  const ignored = C.decide(s, settings({ promo: 0, bait: 0 }));
  assert.equal(collapsed.action, 'collapse');
  assert.equal(ignored.action, 'none');
});
