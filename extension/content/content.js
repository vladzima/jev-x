/*
 * Cut the Noise — content script for x.com / twitter.com.
 *
 * Scope (MVP): the home timeline and lists only. DMs, notifications,
 * profiles and search are never touched.
 *
 * Debugging (any stage of the chain can break silently — X markup,
 * messaging, backend, thresholds):
 *   - open DevTools console on x.com, filter for "ctn"
 *   - call window.__ctnDebug() for a full pipeline snapshot
 *   - enable "Debug logging" in the popup for per-post lines
 *
 * X changes its DOM regularly. If extraction silently stops working,
 * update SELECTORS below. Defensive: unknown markup => posts are left
 * alone, never mangled.
 */

(function () {
  'use strict';

  var CTN = globalThis.CTNComposition;
  if (!CTN) {
    console.warn('[ctn] composition.js failed to load — filtering disabled');
    return;
  }

  // ---- X DOM selectors (maintenance surface) -----------------------------
  // Primary selectors first, fallbacks after. Fallbacks exist because X
  // runs DOM experiments; if the primary hits, fallbacks are never tried.
  var SELECTORS = {
    article: ['article[data-testid="tweet"]', 'div[data-testid="cellInnerDiv"] article'],
    text: ['[data-testid="tweetText"]', 'div[lang]'],
    userName: ['[data-testid="User-Name"]', 'div[data-testid="User-Names"]']
  };

  // Reserved X path prefixes that are never profile handles.
  var RESERVED_PATHS = /^(home|i|explore|search|notifications|messages|settings|compose|hashtag|live|library)$/;

  function pathActive() {
    return /^\/home\b/.test(location.pathname) || /^\/i\/lists\b/.test(location.pathname);
  }

  var BATCH_SIZE = 12;
  var MAX_ATTEMPTS = 3;
  var SCORE_TEXT_LIMIT = 640; // chars of post text sent to the backend

  var settings = JSON.parse(JSON.stringify(CTN.DEFAULT_SETTINGS));
  settings.debug = false;
  var active = false;

  // Pipeline counters, exposed via window.__ctnDebug().
  var counters = {
    scans: 0,
    articlesFound: 0,
    articlesWithText: 0,
    allowlisted: 0,
    noText: 0,
    queued: 0,
    scored: 0,
    retried: 0,
    dropped: 0,
    applied: { none: 0, dim: 0, collapse: 0 },
    errors: 0,
    cacheHits: 0
  };
  var lastError = null;
  var lastExtractedSample = null;
  var recentDecisions = []; // last 10 {action, net, reasons, text}

  // article element -> { key, handle, text, applied }
  var registry = new Map();
  // key -> Set<article>
  var articlesByKey = new Map();
  // key -> dimension scores
  var scoreCache = new Map();
  // keys the user chose to show anyway (this session)
  var overrides = new Set();
  // queue entries: { key, text, attempts }
  var queued = [];
  var inFlight = new Set();
  var scanTimer = null;

  function log() {
    if (!settings.debug) return;
    var args = Array.prototype.slice.call(arguments);
    args.unshift('[ctn]');
    console.debug.apply(console, args);
  }

  function warn() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift('[ctn]');
    console.warn.apply(console, args);
  }

  // ---- hashing (stable, non-crypto; for de-dupe and overrides) -----------
  function hashString(str) {
    var h1 = 0x811c9dc5;
    var h2 = 0x01000193;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      h1 ^= c; h1 = (h1 * 0x01000193) >>> 0;
      h2 ^= (c + i) & 0xff; h2 = (h2 * 0x85ebca6b) >>> 0;
    }
    return h1.toString(36) + '-' + h2.toString(36);
  }

  // ---- settings ------------------------------------------------------------
  function defaults() {
    var d = JSON.parse(JSON.stringify(CTN.DEFAULT_SETTINGS));
    d.debug = false;
    return d;
  }

  function loadSettings(cb) {
    chrome.storage.sync.get(defaults(), function (stored) {
      settings = stored;
      cb();
    });
  }

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'sync') return;
    loadSettings(function () {
      log('settings changed', { weights: settings.weights, enabled: settings.enabled });
      applyAll();
    });
  });

  // ---- extraction ----------------------------------------------------------
  function firstMatch(root, selectorList) {
    for (var i = 0; i < selectorList.length; i++) {
      var el = root.querySelector(selectorList[i]);
      if (el) return { el: el, selector: selectorList[i] };
    }
    return null;
  }

  function extractHandle(article) {
    var nameMatch = firstMatch(article, SELECTORS.userName);
    if (!nameMatch) return null;
    // Method 1: link text like "@handle"
    var links = nameMatch.el.querySelectorAll('a[href^="/"]');
    for (var i = 0; i < links.length; i++) {
      var t = (links[i].textContent || '').trim();
      if (/^@[A-Za-z0-9_]{1,20}$/.test(t)) return t.slice(1).toLowerCase();
    }
    // Method 2 (fallback): profile href like "/handle" or "/i/user/123"
    for (var j = 0; j < links.length; j++) {
      var href = links[j].getAttribute('href') || '';
      var m = href.match(/^\/([A-Za-z0-9_]{1,15})(?:[/?#]|$)/);
      if (m && !RESERVED_PATHS.test(m[1])) return m[1].toLowerCase();
    }
    return null;
  }

  function extractText(article) {
    var match = firstMatch(article, SELECTORS.text);
    if (!match) return '';
    return (match.el.innerText || match.el.textContent || '').trim();
  }

  function allowlisted(handle) {
    if (!handle) return false;
    var list = settings.allowlist || [];
    for (var i = 0; i < list.length; i++) {
      var h = String(list[i] || '').trim().replace(/^@/, '').toLowerCase();
      if (h && h === handle) return true;
    }
    return false;
  }

  // ---- scanning -------------------------------------------------------------
  function scan() {
    var nowActive = pathActive();
    if (nowActive !== active) {
      active = nowActive;
      log('path', location.pathname, 'active:', active);
      if (!active) unapplyAll();
    }
    if (!active || !settings.enabled) return;

    counters.scans++;
    var articles = firstMatch(document, SELECTORS.article)
      ? document.querySelectorAll(SELECTORS.article[0])
      : [];
    if (articles.length === 0 && SELECTORS.article.length > 1) {
      articles = document.querySelectorAll(SELECTORS.article[1]);
    }

    for (var i = 0; i < articles.length; i++) {
      var article = articles[i];
      if (registry.has(article)) {
        if (settings.showScores) ensureStrip(article); // survive re-renders
        continue;
      }

      var handle = extractHandle(article);
      var text = extractText(article);
      var key = hashString((handle || '?') + '\u0000' + text);

      registry.set(article, { key: key, handle: handle, text: text, applied: 'none' });
      if (!articlesByKey.has(key)) articlesByKey.set(key, new Set());
      articlesByKey.get(key).add(article);
      counters.articlesFound++;

      if (lastExtractedSample === null && text) {
        lastExtractedSample = { handle: handle, text: text.slice(0, 80) };
      }

      if (!text) {
        counters.noText++;
        continue; // image/video-only post: leave alone
      }
      counters.articlesWithText++;

      if (allowlisted(handle)) {
        counters.allowlisted++;
        continue;
      }
      if (overrides.has(key)) continue;
      if (scoreCache.has(key)) {
        counters.cacheHits++;
        applyToKey(key, scoreCache.get(key));
        continue;
      }
      if (!inFlight.has(key)) {
        inFlight.add(key);
        queued.push({ key: key, text: text.slice(0, SCORE_TEXT_LIMIT), attempts: 0 });
        counters.queued++;
      }
    }
    drain();
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(function () {
      scanTimer = null;
      scan();
    }, 300);
  }

  var observer = new MutationObserver(function () {
    scheduleScan();
  });

  // ---- scoring batches --------------------------------------------------------
  function requeue(post, reason) {
    post.attempts++;
    counters.retried++;
    if (post.attempts >= MAX_ATTEMPTS) {
      counters.dropped++;
      inFlight.delete(post.key);
      warn('gave up on post after', post.attempts, 'attempts:', reason, '|', post.text.slice(0, 60));
      return;
    }
    var delay = 1000 * Math.pow(2, post.attempts - 1);
    setTimeout(function () {
      queued.push(post);
      drain();
    }, delay);
  }

  function drain() {
    if (queued.length === 0) return;
    var batch = queued.splice(0, BATCH_SIZE);
    if (batch.length === 0) return;
    log('scoring batch of', batch.length);
    chrome.runtime.sendMessage(
      { type: 'CTN_SCORE', posts: batch, interests: settings.interests },
      function (response) {
        if (chrome.runtime.lastError) {
          counters.errors++;
          lastError = 'runtime: ' + chrome.runtime.lastError.message;
          for (var i = 0; i < batch.length; i++) requeue(batch[i], lastError);
          return;
        }
        if (!response) {
          counters.errors++;
          lastError = 'no response from background';
          for (var j = 0; j < batch.length; j++) requeue(batch[j], lastError);
          return;
        }
        if (response.error) {
          counters.errors++;
          lastError = 'backend: ' + response.error;
          warn('backend error:', response.error);
          for (var k = 0; k < batch.length; k++) {
            if (!(response.scores && response.scores[batch[k].key])) {
              requeue(batch[k], lastError);
            }
          }
          // fall through: partial scores may still exist
        }
        var scores = (response && response.scores) || {};
        for (var m = 0; m < batch.length; m++) {
          var post = batch[m];
          var dims = scores[post.key];
          if (!dims) continue; // requeued above
          inFlight.delete(post.key);
          counters.scored++;
          scoreCache.set(post.key, dims);
          applyToKey(post.key, dims);
        }
      }
    );
  }

  // ---- applying / unapplying ---------------------------------------------------
  function applyToKey(key, dims) {
    var set = articlesByKey.get(key);
    if (!set) return;
    set.forEach(function (article) {
      applyOne(article, dims);
    });
  }

  function applyOne(article, dims) {
    var entry = registry.get(article);
    if (!entry) return;
    var decision = CTN.decide(dims, settings);
    if (settings.debug || decision.action !== 'none') {
      recentDecisions.push({
        action: decision.action,
        net: decision.net !== null ? Math.round(decision.net * 100) / 100 : null,
        reasons: decision.reasons,
        uncertain: decision.uncertain,
        text: entry.text.slice(0, 80)
      });
      if (recentDecisions.length > 10) recentDecisions.shift();
    }
    log('decision', decision.action, 'net=' + decision.net, decision.reasons.join(' · '), '|', entry.text.slice(0, 50));

    if (settings.showScores) {
      // Debug mode: never dim/collapse — show what Jev scored instead.
      setApplied(article, { action: 'none' });
      addStrip(article, decision, dims);
    } else {
      removeStrip(article);
      setApplied(article, decision);
    }
  }

  function pct(x) {
    return Math.round(Math.min(1, Math.max(0, x)) * 100);
  }

  // X renders the article as a row flexbox: a div appended to the article
  // itself becomes a flex item *beside* the tweet and squeezes it
  // horizontally. The article's first child is the tweet's column container,
  // so appending there puts the strip *under* the post at full width.
  function addStrip(article, decision, dims) {
    var host = article.firstElementChild || article;
    if (host.querySelector(':scope > .ctn-scores')) return;
    var entry = registry.get(article);
    if (!entry) return;
    var strip = document.createElement('div');
    strip.className = 'ctn-scores';
    var net = decision.net === null ? '—' : (decision.net >= 0 ? '+' : '') + decision.net.toFixed(2);
    var parts = [];
    CTN.DIMENSIONS.forEach(function (dim) {
      var d = dims[dim];
      if (d && typeof d.score === 'number') {
        parts.push(dim.slice(0, 1) + ' ' + pct(d.score));
      }
    });
    var action = decision.action === 'none' ? 'keep' : decision.action;
    strip.textContent = parts.join(' · ')
      + '  |  net ' + net
      + ' → ' + action
      + (decision.uncertain ? ' ±' : '');
    if (decision.reasons.length) {
      strip.textContent += '  (' + decision.reasons.join(' · ') + ')';
    }
    // Full detail (incl. confidence per dimension) on hover.
    strip.title = JSON.stringify({ handle: entry.handle, scores: dims });
    host.appendChild(strip);
  }

  function removeStrip(article) {
    var host = article.firstElementChild || article;
    var strip = host.querySelector(':scope > .ctn-scores');
    if (strip) strip.remove();
  }

  // React re-renders can drop injected children; re-add missing strips
  // during scans using cached scores.
  function ensureStrip(article) {
    if (article.querySelector('.ctn-scores')) return;
    var entry = registry.get(article);
    if (!entry || !entry.text) return;
    var dims = scoreCache.get(entry.key);
    if (!dims) return;
    addStrip(article, CTN.decide(dims, settings), dims);
  }

  function setApplied(article, decision) {
    var entry = registry.get(article);
    if (!entry) return;
    var previous = entry.applied;
    var next = decision.action;

    if (previous === 'collapse' && next !== 'collapse') removeBar(article);
    if (previous === 'dim' && next !== 'dim') article.classList.remove('ctn-dim');
    counters.applied[previous] = Math.max(0, (counters.applied[previous] || 0) - 1);

    if (next === 'dim') {
      article.classList.add('ctn-dim');
    } else if (next === 'collapse') {
      article.classList.add('ctn-collapse');
      addBar(article, decision);
    }
    entry.applied = next;
    counters.applied[next] = (counters.applied[next] || 0) + 1;
  }

  function addBar(article, decision) {
    if (article.querySelector(':scope > .ctn-bar')) return;
    var bar = document.createElement('div');
    bar.className = 'ctn-bar';
    var why = decision.reasons.length
      ? decision.reasons.join(' · ')
      : (decision.uncertain ? 'low confidence' : 'below your sliders');
    var label = document.createElement('span');
    label.className = 'ctn-bar-why';
    label.textContent = 'Cut the noise — ' + why;
    var btn = document.createElement('button');
    btn.className = 'ctn-bar-show';
    btn.type = 'button';
    btn.textContent = 'Show anyway';
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      e.preventDefault();
      var entry2 = registry.get(article);
      if (entry2) overrides.add(entry2.key);
      article.classList.remove('ctn-collapse');
      removeBar(article);
      if (entry2) entry2.applied = 'none';
    });
    bar.appendChild(label);
    bar.appendChild(btn);
    article.appendChild(bar);
  }

  function removeBar(article) {
    var bar = article.querySelector(':scope > .ctn-bar');
    if (bar) bar.remove();
  }

  function unapplyAll() {
    registry.forEach(function (entry, article) {
      article.classList.remove('ctn-dim', 'ctn-collapse');
      removeBar(article);
      removeStrip(article);
      entry.applied = 'none';
    });
    counters.applied = { none: 0, dim: 0, collapse: 0 };
  }

  function applyAll() {
    scoreCache.forEach(function (dims, key) {
      if (overrides.has(key)) return;
      applyToKey(key, dims);
    });
    if (!active || !settings.enabled) unapplyAll();
  }

  // ---- debug snapshot ---------------------------------------------------------
  window.__ctnDebug = function () {
    return {
      version: '0.1.2',
      path: location.pathname,
      pathActive: active,
      enabled: settings.enabled,
      collapseMode: settings.collapseMode,
      showScores: settings.showScores,
      debug: settings.debug,
      weights: settings.weights,
      interests: settings.interests,
      thresholds: { dimBelow: CTN.DIM_BELOW, collapseBelow: CTN.COLLAPSE_BELOW },
      counters: counters,
      lastError: lastError,
      lastExtractedSample: lastExtractedSample,
      queueLength: queued.length,
      inFlight: inFlight.size,
      recentDecisions: recentDecisions,
      hint: recentDecisions.length === 0
        ? 'No decisions yet — extraction or scoring is failing. Check lastError and counters.'
        : undefined
    };
  };

  // ---- init ----------------------------------------------------------------
  function init() {
    loadSettings(function () {
      active = pathActive();
      observer.observe(document.body, { childList: true, subtree: true });
      log('content script active on', location.pathname, '(active:', active + ')');
      scan();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
