/*
 * Cut the Noise — composite scoring.
 *
 * Jev (TypeSafe System One) scores each post once on independent dimensions.
 * This module combines those scores with user-controlled weights, turning
 * sliders into a dim/collapse decision. Weight changes never require
 * re-scoring: the raw dimension scores are cached and reused.
 *
 * Usable as a plain browser script (sets globalThis.CTNComposition, loaded
 * before content.js) and from Node for tests (module.exports).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.CTNComposition = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DIMENSIONS = ['firsthand', 'promo', 'bait', 'depth', 'relevance'];

  var DEFAULT_SETTINGS = {
    enabled: true,
    collapseMode: true,
    // Debug mode: instead of dimming/collapsing, print Jev's scores under
    // each scored post. Actions are suppressed while this is on.
    showScores: false,
    // Slider range is -3..+3 per dimension. Positive = want more,
    // negative = want less, 0 = ignore this dimension entirely.
    weights: {
      firsthand: 2,
      depth: 1,
      relevance: 2,
      promo: -3,
      bait: -3
    },
    interests: '',
    allowlist: []
  };

  // Decision thresholds on the weighted net score (roughly -2 .. +1.7
  // with default weights). Tunable constants, not user-facing for MVP.
  var DIM_BELOW = -0.30;
  var COLLAPSE_BELOW = -0.90;

  // If the least-confident dimension used by the weights falls below this,
  // never collapse the post — dim only. "Leave uncertain posts alone"
  // made concrete: dimming is a soft, reversible hint; collapsing is not.
  var UNCERTAIN_BELOW = 0.30;

  var SHORT_LABELS = {
    firsthand: 'firsthand',
    promo: 'promo',
    bait: 'bait',
    depth: 'depth',
    relevance: 'relevance'
  };

  function clamp(w) {
    if (typeof w !== 'number' || !isFinite(w)) return 0;
    return Math.max(-3, Math.min(3, Math.round(w)));
  }

  // Weight for a dimension as a signed fraction: slider / 3.
  function normalizedWeight(settings, dim) {
    var weights = (settings && settings.weights) || DEFAULT_SETTINGS.weights;
    return clamp(weights[dim]) / 3;
  }

  // Weighted net score. Scores are 0..1 (normalized by the worker before
  // they reach here). Returns null when a dimension with nonzero weight is
  // missing — the caller should leave the post alone, never guess.
  function netScore(scores, settings) {
    if (!scores) return null;
    var net = 0;
    var used = 0;
    for (var i = 0; i < DIMENSIONS.length; i++) {
      var dim = DIMENSIONS[i];
      var w = normalizedWeight(settings, dim);
      if (w === 0) continue;
      used++;
      var s = scores[dim];
      if (!s || typeof s.score !== 'number' || !isFinite(s.score)) return null;
      net += w * s.score;
    }
    if (used === 0) return null; // every slider at 0: do nothing
    return net;
  }

  // Lowest confidence across the dimensions the weights actually use.
  function minConfidence(scores, settings) {
    var min = 1;
    var used = 0;
    for (var i = 0; i < DIMENSIONS.length; i++) {
      var dim = DIMENSIONS[i];
      if (normalizedWeight(settings, dim) === 0) continue;
      used++;
      var c = scores && scores[dim] && scores[dim].confidence;
      if (typeof c !== 'number' || !isFinite(c)) c = 0;
      min = Math.min(min, c);
    }
    return used === 0 ? 0 : min;
  }

  // Human-readable reasons for dimming/collapsing: the most negative
  // weighted contributions, e.g. "promo 92% · bait 71%".
  function reasons(scores, settings) {
    if (!scores) return [];
    var rows = [];
    for (var i = 0; i < DIMENSIONS.length; i++) {
      var dim = DIMENSIONS[i];
      var w = normalizedWeight(settings, dim);
      if (w === 0) continue;
      var s = scores[dim];
      if (!s || typeof s.score !== 'number') continue;
      rows.push({ dim: dim, contribution: w * s.score, score: s.score });
    }
    rows.sort(function (a, b) { return a.contribution - b.contribution; });
    var out = [];
    for (var j = 0; j < rows.length && out.length < 2; j++) {
      if (rows[j].contribution < -0.05) {
        out.push(SHORT_LABELS[rows[j].dim] + ' ' + Math.round(rows[j].score * 100) + '%');
      }
    }
    return out;
  }

  /*
   * The single decision function. Input: dimension scores from the backend
   * (each {score: 0..1, confidence: 0..1}) and user settings. Output:
   * { action: 'none' | 'dim' | 'collapse', net, uncertain, reasons }.
   */
  function decide(scores, settings) {
    var net = netScore(scores, settings);
    if (net === null) {
      return { action: 'none', net: null, uncertain: false, reasons: [] };
    }
    var uncertain = minConfidence(scores, settings) < UNCERTAIN_BELOW;
    var action = 'none';
    if (net <= COLLAPSE_BELOW && !uncertain) {
      action = 'collapse';
    } else if (net <= DIM_BELOW) {
      action = 'dim';
    }
    if (action === 'collapse' && !(settings && settings.collapseMode)) {
      action = 'dim';
    }
    return {
      action: action,
      net: net,
      uncertain: uncertain,
      reasons: reasons(scores, settings)
    };
  }

  return {
    DIMENSIONS: DIMENSIONS,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    DIM_BELOW: DIM_BELOW,
    COLLAPSE_BELOW: COLLAPSE_BELOW,
    UNCERTAIN_BELOW: UNCERTAIN_BELOW,
    decide: decide,
    netScore: netScore,
    minConfidence: minConfidence,
    reasons: reasons,
    normalizedWeight: normalizedWeight,
    clamp: clamp
  };
});
