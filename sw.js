/* Field Measure — service worker.
 *
 * Its whole job is making the app open in a crawlspace with no signal. It keeps a
 * copy of the app's own files and serves those first, checking for a newer version
 * in the background.
 *
 * Bump VERSION whenever the app files change, or phones will keep serving the old
 * copy from cache.
 */
var VERSION = 'fm-v1';
var CORE = [
  './',
  'index.html',
  'config.js',
  'storage.js',
  'manifest.webmanifest',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(VERSION).then(function (c) {
      /* One at a time rather than addAll, so a single file that fails to fetch
         (a CDN hiccup) does not abandon the whole install. */
      return Promise.all(CORE.map(function (u) {
        return c.add(new Request(u, { cache: 'reload' })).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== VERSION; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  /* Never cache the database or anything auth-related. Stale measurements or a
     stale session would be worse than no answer at all. */
  if (url.hostname.indexOf('supabase') !== -1) return;

  e.respondWith(
    caches.open(VERSION).then(function (cache) {
      return cache.match(req).then(function (hit) {
        var fresh = fetch(req).then(function (res) {
          /* Opaque cross-origin responses (fonts) have status 0 but are still
             usable from cache, so keep those too. */
          if (res && (res.ok || res.type === 'opaque')) {
            cache.put(req, res.clone()).catch(function () {});
          }
          return res;
        }).catch(function () { return null; });

        /* Serve the cached copy at once if we have one, and let the fetch above
           quietly refresh it for next launch. */
        if (hit) return hit;
        return fresh.then(function (res) {
          if (res) return res;
          /* Offline with nothing cached: for a page request, fall back to the
             app shell so the user sees the app rather than a browser error. */
          if (req.mode === 'navigate') return cache.match('index.html');
          return new Response('', { status: 504, statusText: 'Offline' });
        });
      });
    })
  );
});
