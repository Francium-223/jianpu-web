#!/usr/bin/env node
/**
 * 把 `static/` 与 `data/` 拼成可部署的静态目录（默认 `dist/`）。
 *
 * 为什么需要这一层: 本机的 `app/server.py` 把 `<项目根>/` 映射到 `static/`、`/data` 映射到 `data/`,
 * 而静态托管的"资源根"不一样 —— `index.html` 必须就在这个根上, 相对的 `./static/app.js`、
 * `./data/x.gz` 才解析得对。拼出来的 dist 与线上**URL 完全一致**(/、/static/*、/data/*、/s/<id>),
 * 所以前端一行都不用改。
 *
 * 为什么用 Node 而不是 Python 写: Cloudflare 的构建镜像里只有 Node —— 构建命令必须是
 * `npm run build`, 不能依赖 python3; 顺带 GitHub Actions 部署 Pages 也是一条命令。
 *
 * 两个目标(`--target`, 默认 cf):
 *   * `cf` —— Cloudflare Workers/Pages 的 assets。多写一个 `_headers`(缓存策略);
 *     深链回退靠 `wrangler.jsonc` 里的 `not_found_handling: single-page-application`。
 *   * `gh` —— **GitHub Pages** 这类纯静态托管(`user.github.io/<repo>/`)。多写:
 *       - `.nojekyll` —— 否则 Jekyll 会来插手(带下划线的文件等);
 *       - `404.html`  —— 内容与 index.html **逐字节相同**; Pages 对未知路径就发它,
 *                        于是 `/jianpu-web/s/<id>` 这种深链也能打开(index.html 里那段内联
 *                        `<base>` 会按"文档地址 = 应用根 + s/<id>"把相对路径摆正 —— 已有自检看着)。
 *     不写 `_headers`(Cloudflare 的语法, GH Pages 不认; 文件名带内容哈希, 不靠它也安全)。
 *
 * 只读镜像: `--api` 不给时注入 `window.JIANPU_READONLY=true` —— 检索/谱页全在浏览器里跑,
 * 但"投稿/补收录/补标签"要写回本机服务, 纯静态托管做不到, 前端就直接说人话, 而不是发一个必 404 的请求。
 * 想让它照样能投稿: `--api https://jianpu-web.pages.dev`(Worker 允许跨域, 再由它转发给本机)。
 *
 * ⚠ 只带 `.gz` 的数据文件: 明文 `data/songs.jsonl`(13MB) 与 `images.jsonl`(3MB) 是**本地生成、
 *   .gitignore 掉**的, 云端构建拿不到它们。所以没有 DecompressionStream 的老浏览器在云端
 *   会走不通(本机部署仍然有回退)。要支持就把它俩也提交进仓库, 然后在这里加两行。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

function argOf(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith('--') ? v : dflt;
}
const TARGET = argOf('target', 'cf');
if (TARGET !== 'cf' && TARGET !== 'gh') {
  console.error(`  ! --target 只认 cf / gh（给的是 ${TARGET}）`);
  process.exit(2);
}
const DIST = resolve(ROOT, argOf('out', TARGET === 'gh' ? 'dist-gh' : 'dist'));
const API = argOf('api', '');            // 只有 gh 目标用得上; 不给 = 只读镜像

const STATIC_FILES = ['app.js', 'search.js', 'jptok.js', 'style.css'];
// 静态资源带**内容哈希**文件名(app.<hash>.js): 否则 `_headers` 里的长缓存会让部署后
// 部分边缘节点继续发旧 JS —— 实测踩到(截图上谱页还在渲染碎图 / 浏览器里 img 数为 0, 两种结果并存)。
// 带哈希后长缓存就安全了: 内容一变 URL 就变。JS 里 `./search.js` 这类 import 也要一起改。
// ⚠ **不打包 images.jsonl.gz**（省 0.5MB）: 2026-09-24 用户口径 —— 前端不要"原图"那一栏,
//   既不转存扫描件也不外链图片; 原站页面地址在「出处」/「收录页」里。所以线上不需要图索引。
const DATA_FILES = ['songs.jsonl.gz', 'stats.json'];

rmSync(DIST, { recursive: true, force: true });
let n = 0, bytes = 0;

function put(src, rel) {
  if (!existsSync(src)) {
    console.error(`  ! 缺少 ${rel}（${src}）—— 先跑 refresh/构建索引`);
    process.exitCode = 1;
    return;
  }
  const dst = join(DIST, rel);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  const sz = statSync(dst).size;
  n += 1; bytes += sz;
  console.log(`  ${rel.padEnd(28)} ${(sz / 1e6).toFixed(2)} MB`);
}

/** 内容哈希(8 位) + 把 static/ 下四个文件改成 app.<hash>.js 这种名字, 并改掉相互 import。 */
function hashedStatic() {
  const map = {};                       // 原名 -> 新名
  for (const f of STATIC_FILES) {
    const src = join(ROOT, 'static', f);
    if (!existsSync(src)) continue;
    const h = createHash('sha256').update(readFileSync(src)).digest('hex').slice(0, 8);
    const ext = f.slice(f.lastIndexOf('.'));
    map[f] = f.slice(0, -ext.length) + '.' + h + ext;
  }
  for (const f of STATIC_FILES) {
    const src = join(ROOT, 'static', f);
    if (!existsSync(src) || !map[f]) continue;
    let body = readFileSync(src, 'utf8');
    for (const [oldName, newName] of Object.entries(map)) {   // 改 import/相对引用
      body = body.split('./' + oldName).join('./' + newName);
    }
    const rel = 'static/' + map[f];
    const dst = join(DIST, rel);
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, body);
    const sz = statSync(dst).size;
    n += 1; bytes += sz;
    console.log(`  ${rel.padEnd(28)} ${(sz / 1e6).toFixed(2)} MB  (原名 ${f})`);
  }
  // index.html 里的 ./static/xxx 也改掉
  let html = readFileSync(join(DIST, 'index.html'), 'utf8');
  for (const [oldName, newName] of Object.entries(map)) {
    html = html.split('./static/' + oldName).join('./static/' + newName);
  }
  writeFileSync(join(DIST, 'index.html'), html);
  return map;
}

/** gh 目标: 把"只读 / 接口地址"两个开关内联进 index.html(在 `<base>` 那段之后、app.js 之前)。 */
function injectFlags() {
  const idx = join(DIST, 'index.html');
  const html = readFileSync(idx, 'utf8');
  const js = API ? `window.JIANPU_API=${JSON.stringify(API)};` : 'window.JIANPU_READONLY=true;';
  const out = html.replace('</head>', '<script>' + js + '</script>\n</head>');
  if (out === html) {                                  // 万一 index.html 结构变了: 别静默失败
    console.error('  ! index.html 里找不到 </head>, 开关注入失败');
    process.exitCode = 1;
    return [];
  }
  writeFileSync(idx, out);
  return [js];
}

console.log(`拼 ${DIST.slice(ROOT.length + 1) || DIST}/  (target=${TARGET}${TARGET === 'gh' ? (API ? `, api=${API}` : ', 只读') : ''}):`);
put(join(ROOT, 'static', 'index.html'), 'index.html');          // 入口必须在资源根上
hashedStatic();
for (const f of DATA_FILES) put(join(ROOT, 'data', f), `data/${f}`);

if (TARGET === 'cf') {
  // 缓存策略: 交给 Cloudflare 的 _headers(assets 支持)。数据每次 push 都重新部署,
  // 所以给一个小时稳稳的; HTML 不缓存, 免得部署完还看到旧页面。
  const headers = [
    '/',
    '  Cache-Control: no-cache',
    '/index.html',
    '  Cache-Control: no-cache',
    '/static/*',
    '  Cache-Control: public, max-age=31536000, immutable',   // 文件名带内容哈希, 可以永久缓存
    '/data/*',
    '  Cache-Control: public, max-age=3600',
    '',
  ].join('\n');
  mkdirSync(DIST, { recursive: true });
  writeFileSync(join(DIST, '_headers'), headers);
  console.log(`  _headers                     ${headers.length} B`);
  n += 1;
} else {
  const flags = injectFlags();
  for (const f of flags) console.log(`  index.html 内联开关           ${f}`);
  n += flags.length ? 1 : 0;
  // 404.html 必须在开关注入**之后**复制, 两份逐字节相同(自检会盯着这一条)
  copyFileSync(join(DIST, 'index.html'), join(DIST, '404.html'));
  writeFileSync(join(DIST, '.nojekyll'), '');
  console.log('  404.html                     = index.html（Pages 深链回退）');
  console.log('  .nojekyll                    0 B（别让 Jekyll 插手）');
  n += 2;
}

console.log(`${DIST.slice(ROOT.length + 1) || DIST}/ 就绪: ${n} 个文件, ${(bytes / 1e6).toFixed(2)} MB`);
console.log('  入口 index.html · 不带图索引（前端不显示原图, 见 worker/index.js 顶部说明）');
