/**
 * 简谱旋律查歌 —— Cloudflare Worker（把本机那套服务搬到边缘, 但**写路径仍留在本机**）
 *
 * 同一个域名下三类请求:
 *   /img/<相对工作区的路径>   → R2 桶里的原图（原图 5GB, 进不了仓库也进不了 Worker; R2 免费 10GB）
 *                              R2 里没有 / 没绑桶时, 如果配了 IMG_UPSTREAM, 就**反代回本机**取
 *                              —— 于是"不想开 R2 / 桶还没建"也能先把站点跑起来（代价: 原图走家里上行）
 *   /api/*                    → **反向代理**到本机的 app/server.py（要配 API_UPSTREAM）
 *   其它（/、/static/*、/data/*、/s/<id>）
 *                             → env.ASSETS（构建产物 dist/）; 找不到的路径由
 *                               not_found_handling="single-page-application" 兜回 index.html,
 *                               `/s/<id>` 这种深链因此直接可用
 *
 * 为什么 /api/* 是代理而不是在这里重写:
 *   投稿要写 scores/*.txt + git commit, 而"怎么校验一个收录页 URL""怎么把简谱数字归一化"
 *   这些口径**只有一份实现**（jianpu-db/linkurl.py + score.py + schema.py）。在这里用 JS 再写一遍
 *   必然漂。所以 Worker 只负责"把请求转给本机、把本机的话原样转回来"。
 *   代价: 投稿需要本机在线（读路径完全不需要 —— 检索、卡片、谱页、原图都在边缘）。
 *
 * 配好之后 /api/health 会显示 api 是 true/false, 一眼看出这台部署有没有投稿后端。
 */

const IMG_PREFIX = '/img/';
const IMG_CACHE = 'public, max-age=604800, immutable';
const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path.startsWith(IMG_PREFIX)) {
      return serveImage(request, env, url);
    }
    if (path.startsWith('/api/')) {
      if (path === '/api/health') {
        return json({ ok: true, deploy: 'cloudflare-worker',
                      images: env.IMAGES ? 'r2' : (env.IMG_UPSTREAM ? 'proxy' : 'none'),
                      api: !!env.API_UPSTREAM, upstream: env.API_UPSTREAM || null });
      }
      return proxyApi(request, env, url);
    }
    return env.ASSETS.fetch(request);
  },
};

/** 原图: 与 app/server.py 同样三道闸（逐段查 .. / 扩展名白名单 / 方法只认 GET-HEAD）。 */
async function serveImage(request, env, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('method not allowed', { status: 405 });
  }
  // ⚠ key 有**两种写法**, 都得认:
  //   * 规范形式 = 解码后的原样 UTF-8 路径（`images-prep/…/怀念__jianpucn-100009/001.jpg`）
  //     —— S3 API / rclone / aws-cli 上传就是这个形式, 这是我们要的规范。
  //   * `wrangler r2 object put` 会把 key **百分号编码**后再存（实测: 存进去的 key 是
  //     `…/%E6%80%80%E5%BF%B5__…`）—— 用它传的文件只有原样路径能找到。
  //   所以先按解码后的找, 找不到再用 URL 原样路径找一遍（顺序固定, 结果可预期）。
  const raw = url.pathname.slice(IMG_PREFIX.length);
  const keys = [];
  try {
    const dec = decodeURIComponent(raw);
    keys.push(dec);
    if (dec !== raw) keys.push(raw);
  } catch {
    keys.push(raw);                              // 编码坏了: 至少按原样试一次, 不 500
  }
  const bad = (k) => !k || k.includes('\\') ||
    k.split('/').some((p) => p === '' || p === '.' || p === '..');
  const ext = ((keys[0] || '').match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
  if (bad(keys[0]) || !IMG_EXT.has(ext)) {
    return new Response('bad path', { status: 404 });
  }
  let obj = null;
  if (env.IMAGES) {
    for (const k of keys) {
      obj = await env.IMAGES.get(k);
      if (obj) break;
    }
  }
  if (!obj) {
    // 没绑 R2 / 桶里没有 -> 兜底反代回本机（不需要 R2 也能看图）
    if (env.IMG_UPSTREAM) {
      return proxyFetch(request, env, env.IMG_UPSTREAM.replace(/\/+$/, '') + url.pathname + url.search);
    }
    return new Response(env.IMAGES ? 'not found'
                                   : 'R2 桶没绑定, 也没配 IMG_UPSTREAM(见 wrangler.jsonc)',
                        { status: env.IMAGES ? 404 : 503 });
  }
  const h = new Headers();
  obj.writeHttpMetadata(h);
  if (!h.get('content-type') || h.get('content-type') === 'application/octet-stream') {
    h.set('content-type', MIME[ext] || 'application/octet-stream');
  }
  h.set('etag', obj.httpEtag);
  h.set('cache-control', IMG_CACHE);
  return new Response(request.method === 'HEAD' ? null : obj.body, { headers: h });
}

/** /api/* → 本机服务。带上 X-Token（Worker secret）, 本机设了 JPSUBMIT_TOKEN 就只认它。 */
async function proxyApi(request, env, url) {
  const upstream = (env.API_UPSTREAM || '').replace(/\/+$/, '');
  if (!upstream) {
    return json({ ok: false, err: '这台部署没有配投稿后端: 投稿要在作者本机的服务上跑' +
                                  '（wrangler secret put API_UPSTREAM / API_TOKEN）' }, 503);
  }
  return proxyFetch(request, env, upstream + url.pathname + url.search);
}

/** 把请求原样转给本机服务（/api/* 与"R2 里没有的原图"共用这一条）。 */
async function proxyFetch(request, env, target) {
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('cf-connecting-ip');
  if (env.API_TOKEN) {
    headers.set('X-Token', env.API_TOKEN);
  }
  headers.set('X-Forwarded-Proto', 'https');
  const init = { method: request.method, headers, redirect: 'manual' };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
  }
  let res;
  try {
    res = await fetch(target, init);
  } catch (e) {
    return json({ ok: false, err: '连不上本机后端（服务没开? 隧道断了?）: ' + e.message }, 502);
  }
  const out = new Headers(res.headers);
  out.set('Access-Control-Allow-Origin', '*');
  return new Response(res.body, { status: res.status, headers: out });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8',
               'cache-control': 'no-store', 'Access-Control-Allow-Origin': '*' },
  });
}
