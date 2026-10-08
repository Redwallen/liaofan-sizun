/* ============================================================
   《了凡四训》逐句精读 —— Service Worker
   让网站可以「添加到主屏幕」并离线阅读。
   改动静态资源后，请把 VERSION 加一，旧缓存会在下次访问时清理。
   ============================================================ */
var VERSION = 'liaofan-v4';

var ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/sync.js',
  './js/app.js',
  './data/book.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png'
];

var SCOPE_PATH = new URL(self.registration.scope).pathname;

/** 账号 / 同步接口一律不走缓存，否则会拿到过期的登录状态 */
function isApiRequest(pathname) {
  return pathname.indexOf(SCOPE_PATH + 'api/') === 0;
}

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(VERSION)
      .then(function (c) { return c.addAll(ASSETS); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (k) {
          return k === VERSION ? null : caches.delete(k);
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;
  if (isApiRequest(url.pathname)) return; // 交给网络，不缓存

  // 导航请求：优先用缓存的 index.html，保证离线也能打开
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(function () { return caches.match('./index.html'); })
    );
    return;
  }

  // 其余资源：缓存优先，命中就直接返回，未命中再联网并回填
  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && res.status === 200 && res.type === 'basic') {
          var copy = res.clone();
          caches.open(VERSION).then(function (c) { c.put(req, copy); });
        }
        return res;
      });
    })
  );
});
