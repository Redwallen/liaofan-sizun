/* ============================================================
   地区门禁（region gate）—— 只对中国大陆开放

   规则：
   - 只有 request.cf.country === 'CN' 的访客可以访问站点内容。
   - 其他地区（美国、日本等）自动 302 跳到 /unavailable，
     在那里看到 “This website is not available in your region”。
   - 港澳台是独立的 ISO 代码（HK / MO / TW），不属于 CN，
     按“仅大陆”的要求同样被拦截。

   注意：
   - 这个文件在四个项目里各存一份（book / ESAT / lobby / photo-site），
     内容必须保持一致；改一处请四处同步。
   - 依赖 wrangler.jsonc 里的 "run_worker_first": true，
     否则静态资源不经过 Worker，门禁形同虚设。

   判断依据是 Cloudflare 边缘节点的 IP 地理位置，属于业务与合规层面的
   信号，不是安全边界：在中国用境外出口的访客会被误拦，在境外走中国
   出口的访客能进来。
   ============================================================ */

/** 允许访问的国家/地区代码，ISO 3166-1 alpha-2。仅中国大陆。 */
const ALLOWED_COUNTRIES = new Set(['CN']);

/** 拦截页路径。这个路径本身永远不被门禁拦截，否则会无限重定向。 */
export const BLOCK_PAGE_PATH = '/unavailable';

/** 规范化路径：去掉结尾斜杠，方便和 BLOCK_PAGE_PATH 比较。 */
function normalizePath(pathname) {
  if (pathname.length > 1) return pathname.replace(/\/+$/, '') || '/';
  return pathname;
}

/** 当前请求是不是拦截页本身。 */
export function isBlockPagePath(pathname) {
  return normalizePath(pathname) === BLOCK_PAGE_PATH;
}

/**
 * 本地开发的 host 兑底判断。
 *
 * 注意：四个项目都配了 routes / custom_domain，`wrangler dev` 会让 Worker
 * 看到的 host 变成线上域名（例如 photos.redwallen.cn）而不是 localhost，
 * 所以这个分支在那种情况下不会命中。本地开发真正的开关是项目根目录的
 * .dev.vars：
 *   REGION_GATE=off
 * 这个函数只是给没配 routes 的场景（例如 book/wrangler.dev.jsonc）兑底。
 *
 * 线上不可能被绕过：Cloudflare 按 Host 把请求路由到对应域区，
 * Host 是 localhost 的请求根本到不了已部署的 Worker。
 */
function isLocalDevHost(hostname) {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1' ||
    hostname.endsWith('.localhost')
  );
}

/**
 * 读取访客国家码。
 * 只保留两位大写字母，避免任何非预期字符进入页面 HTML；拿不到就返回空串。
 */
function readCountry(request) {
  const cf = request.cf;
  const raw = cf && typeof cf.country === 'string' ? cf.country.toUpperCase() : '';
  return /^[A-Z]{2}$/.test(raw) ? raw : '';
}

/**
 * 计算门禁结果。
 * country 在任何分支都会带上，拦截页要靠它显示“检测到的地区”。
 * @returns {{blocked: boolean, reason: string, country: string}}
 */
export function gateState(request, env) {
  const url = new URL(request.url);
  const country = readCountry(request);

  // 拦截页自身永远放行，否则 302 跳过去会无限重定向。
  if (isBlockPagePath(url.pathname)) return { blocked: false, reason: 'block-page', country };

  // 显式关闭（例如本地 dev 配置里 vars: { REGION_GATE: "off" }）
  if (env && env.REGION_GATE === 'off') return { blocked: false, reason: 'disabled', country };

  if (isLocalDevHost(url.hostname)) return { blocked: false, reason: 'local-dev', country };

  if (country && ALLOWED_COUNTRIES.has(country)) return { blocked: false, reason: 'allowed', country };

  // 拿不到国家信息时按“不放行”处理（fail closed）
  return { blocked: true, reason: country ? 'country' : 'unknown-country', country };
}

/** 门禁相关的响应一律不缓存：它随访客地理位置变化，不能被边缘或浏览器复用。 */
function noStore(headers) {
  const h = new Headers(headers);
  h.set('Cache-Control', 'no-store, max-age=0');
  h.set('X-Content-Type-Options', 'nosniff');
  return h;
}

/**
 * 被拦截时的响应。
 * 页面请求 → 302 跳到 /unavailable（用 302 而非 301，避免浏览器长期缓存，
 * 否则访客以后到了中国还会被旧的跳转挡住）。
 * /api/* → 直接返回 JSON 451，因为把 fetch 重定向到 HTML 页会报更难懂的错。
 */
export function blockedResponse(request, state) {
  const url = new URL(request.url);

  if (url.pathname.startsWith('/api/')) {
    return new Response(
      JSON.stringify({
        error: 'This website is not available in your region.',
        reason: state.reason,
      }),
      { status: 451, headers: noStore({ 'Content-Type': 'application/json; charset=utf-8' }) },
    );
  }

  const target = new URL(BLOCK_PAGE_PATH, url);
  const headers = noStore({});
  headers.set('Location', target.toString());
  return new Response(null, { status: 302, headers });
}

/** 拦截页。样式与脚本全部内联，不引用站内任何资源（那些资源同样被门禁挡住）。 */
export function blockPage(state) {
  const country = state && state.country ? state.country : '';
  const regionLine = country
    ? `<p class="meta">Detected region: <code>${country}</code></p>`
    : `<p class="meta">Region could not be determined.</p>`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Unavailable</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 24px;
    background: #f6f6f4;
    color: #1c1c1a;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
                 "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }
  .card { width: 100%; max-width: 34rem; text-align: center; }
  .mark { display: block; margin: 0 auto 1.75rem; color: #b4b4ac; }
  h1 {
    margin: 0 0 1rem;
    font-size: clamp(1.25rem, 4vw, 1.6rem);
    font-weight: 600;
    line-height: 1.45;
    letter-spacing: -0.01em;
  }
  p { margin: 0 0 0.5rem; font-size: 0.95rem; line-height: 1.75; color: #5c5c57; }
  .zh { color: #6f6f68; }
  .rule {
    width: 3rem; height: 1px; margin: 1.75rem auto;
    background: currentColor; opacity: 0.15; border: 0;
  }
  .meta {
    margin-top: 0; font-size: 0.75rem; line-height: 1.6;
    color: #9a9a93; letter-spacing: 0.02em;
  }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.75rem; padding: 0.1rem 0.3rem;
    border-radius: 3px; background: rgba(0, 0, 0, 0.06);
  }
  @media (prefers-color-scheme: dark) {
    body { background: #141413; color: #ececea; }
    .mark { color: #55554f; }
    p { color: #a3a39c; }
    .zh { color: #918f89; }
    .meta { color: #6b6b66; }
    code { background: rgba(255, 255, 255, 0.09); }
  }
</style>
</head>
<body>
<main class="card">
  <svg class="mark" width="44" height="44" viewBox="0 0 24 24" fill="none"
       stroke="currentColor" stroke-width="1.5" aria-hidden="true">
    <circle cx="12" cy="12" r="9"></circle>
    <path d="M5.6 5.6l12.8 12.8"></path>
  </svg>
  <h1>This website is not available in your region</h1>
  <p>This service is only available to visitors in mainland China.</p>
  <p class="zh">本网站仅向中国大陆地区开放，您所在的地区暂不可用。</p>
  <hr class="rule">
  <p class="meta">451 Unavailable</p>
  ${regionLine}
</main>
</body>
</html>
`;

  return new Response(html, {
    status: 451,
    headers: noStore({ 'Content-Type': 'text/html; charset=utf-8' }),
  });
}
