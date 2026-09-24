#!/usr/bin/env node
/**
 * 把 `static/` 与 `data/` 拼成 Cloudflare Workers 的静态资源目录 `dist/`。
 *
 * 为什么需要这一层: 本机的 `app/server.py` 把 `<项目根>/` 映射到 `static/`、`/data` 映射到 `data/`,
 * 而 Workers 的 assets 只认"资源根"——`index.html` 必须就在这个根上, 相对的 `./static/app.js`、
 * `./data/x.gz` 才解析得对。拼出来的 dist 与线上**URL 完全一致**(/、/static/*、/data/*、/s/<id>),
 * 所以前端一行都不用改。
 *
 * 为什么用 Node 而不是 Python 写: Cloudflare 的构建镜像里只有 Node —— 构建命令必须是
 * `npm run build`, 不能依赖 python3。
 *
 * ⚠ 只带 `.gz` 的数据文件: 明文 `data/songs.jsonl`(13MB) 与 `images.jsonl`(3MB) 是**本地生成、
 *   .gitignore 掉**的, 云端构建拿不到它们。所以没有 DecompressionStream 的老浏览器在云端
 *   会走不通(本机部署仍然有回退)。要支持就把它俩也提交进仓库, 然后在这里加两行。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const DIST = join(ROOT, 'dist');

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

console.log('拼 dist/:');
put(join(ROOT, 'static', 'index.html'), 'index.html');          // 入口必须在资源根上
hashedStatic();
for (const f of DATA_FILES) put(join(ROOT, 'data', f), `data/${f}`);


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

console.log(`dist/ 就绪: ${n} 个文件, ${(bytes / 1e6).toFixed(2)} MB`);
console.log('  入口 dist/index.html · 不带图索引（前端不显示原图, 见 worker/index.js 顶部说明）');
