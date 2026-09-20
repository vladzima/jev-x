/* Cut the Noise — popup logic. Settings sync instantly (chrome.storage.sync);
 * the content script listens for changes and re-filters without rescoring.
 * Backend URL/token are local-only. Saving a new backend origin requests
 * the matching optional host permission. */

// The five slider inputs map 1:1 to the scored dimensions (see
// extension/lib/composition.js and worker/src/questions.ts).
var DIMS = ['firsthand', 'promo', 'bait', 'depth', 'relevance'];

var $ = function (id) { return document.getElementById(id); };

function sliderLabel(v) {
  if (v > 0) return '+' + v;
  if (v < 0) return String(v);
  return 'off';
}

function loadSettings() {
  chrome.storage.sync.get({
    enabled: true,
    collapseMode: true,
    debug: false,
    showScores: false,
    weights: { firsthand: 2, depth: 1, relevance: 2, promo: -3, bait: -3 },
    interests: '',
    allowlist: []
  }, function (s) {
    $('enabled').checked = !!s.enabled;
    $('collapseMode').checked = !!s.collapseMode;
    $('debug').checked = !!s.debug;
    $('showScores').checked = !!s.showScores;
    $('interests').value = s.interests || '';
    DIMS.forEach(function (d) {
      $('w-' + d).value = s.weights[d];
      $('v-' + d).textContent = sliderLabel(s.weights[d]);
    });
    var list = (s.allowlist || []).join('\n');
    $('allowlist').value = list;
  });
}

function loadBackend() {
  chrome.storage.local.get(['backendUrl', 'backendToken'], function (s) {
    $('backendUrl').value = s.backendUrl || '';
    $('backendToken').value = s.backendToken || '';
  });
}

var saveTimer = null;
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 300);
}

function save() {
  var weights = {};
  DIMS.forEach(function (d) { weights[d] = parseInt($('w-' + d).value, 10) || 0; });
  var allowlist = $('allowlist').value
    .split(/[\n,]+/)
    .map(function (h) { return h.trim().replace(/^@/, ''); })
    .filter(Boolean);

  chrome.storage.sync.set({
    enabled: $('enabled').checked,
    collapseMode: $('collapseMode').checked,
    debug: $('debug').checked,
    showScores: $('showScores').checked,
    interests: $('interests').value.trim().slice(0, 300),
    weights: weights,
    allowlist: allowlist
  });

  var url = $('backendUrl').value.trim().replace(/\/+$/, '');
  chrome.storage.local.set({ backendUrl: url, backendToken: $('backendToken').value });
  maybeRequestOriginPermission(url);

  var el = $('saveStatus');
  el.textContent = 'Saved';
  el.className = 'status ok';
  setTimeout(function () { el.textContent = ''; }, 1200);
}

function maybeRequestOriginPermission(url) {
  if (!url) return;
  var origin;
  try { origin = new URL(url).origin + '/*'; } catch (e) { return; }
  chrome.permissions.contains({ origins: [origin] }, function (has) {
    if (!has) chrome.permissions.request({ origins: [origin] });
  });
}

// ---- wiring ---------------------------------------------------------------

$('enabled').addEventListener('change', scheduleSave);
$('collapseMode').addEventListener('change', scheduleSave);
$('debug').addEventListener('change', scheduleSave);
$('showScores').addEventListener('change', scheduleSave);
$('interests').addEventListener('input', scheduleSave);
$('allowlist').addEventListener('input', scheduleSave);
$('backendUrl').addEventListener('input', scheduleSave);
$('backendToken').addEventListener('input', scheduleSave);

DIMS.forEach(function (d) {
  $('w-' + d).addEventListener('input', function () {
    $('v-' + d).textContent = sliderLabel(parseInt(this.value, 10));
    scheduleSave();
  });
});

$('testBtn').addEventListener('click', function () {
  var status = $('testStatus');
  var url = $('backendUrl').value.trim().replace(/\/+$/, '');
  var token = $('backendToken').value;
  status.textContent = 'Testing…';
  status.className = 'status';
  var origin;
  try { origin = new URL(url).origin + '/*'; } catch (e) {
    status.textContent = 'Invalid URL';
    status.className = 'status err';
    return;
  }
  chrome.permissions.contains({ origins: [origin] }, function (has) {
    var go = function () {
      fetch(url + '/v1/ping', { headers: { 'x-api-token': token } })
        .then(function (res) {
          if (res.status === 401) {
            status.textContent = 'Token rejected — re-copy WORKER_TOKEN from the devbox';
            status.className = 'status err';
            return null;
          }
          return res.json();
        })
        .then(function (body) {
          if (!body) return;
          if (body.ok) {
            status.textContent = 'OK — token valid' + (body.scoring ? ', Jev ready' : ', but scoring key missing');
            status.className = body.scoring ? 'status ok' : 'status err';
          } else {
            status.textContent = 'Backend responded, but not healthy';
            status.className = 'status err';
          }
        })
        .catch(function () {
          status.textContent = 'Cannot reach backend';
          status.className = 'status err';
        });
    };
    if (!has) {
      chrome.permissions.request({ origins: [origin] }, function (granted) {
        if (granted) go();
        else {
          status.textContent = 'Permission for this origin was declined';
          status.className = 'status err';
        }
      });
    } else {
      go();
    }
  });
});

loadSettings();
loadBackend();
