// node tools/check_live.mjs [base] —— 对着**真的跑起来的服务**做一次端到端:
//   走 HTTP 取 /data/songs.jsonl.gz 与 /static/*.js, 用**前端自己的检索代码**查一句。
// 用法: node tools/check_live.mjs http://127.0.0.1:8770
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const BASE = (process.argv[2] || 'http://127.0.0.1:8770').replace(/\/$/, '');
const ROOT = new URL('..', import.meta.url).pathname;
const { buildIndex, search } = await import(pathToFileURL(resolve(ROOT, 'static/search.js')).href);
const { parseQuery } = await import(pathToFileURL(resolve(ROOT, 'static/jptok.js')).href);

let fail = 0;
const ok = (c, m) => { console.log((c ? '✓ ' : '✗ ') + m); if (!c) fail++; };

// ① 服务活着
const health = await (await fetch(BASE + '/api/health')).json();
ok(health.ok === true, `/api/health ok=true (repo=${health.repo})`);

// ② 走 HTTP 取索引数据
const r = await fetch(BASE + '/data/songs.jsonl.gz');
ok(r.ok, `/data/songs.jsonl.gz HTTP ${r.status} ${r.headers.get('content-type')}`);
const text = gunzipSync(Buffer.from(await r.arrayBuffer())).toString('utf8');
const lines = text.split('\n').filter((x) => x.trim());
ok(lines.length === 7385, `索引 ${lines.length} 首(期望 7385)`);
const idx = buildIndex(text);
ok(idx && idx.songs && idx.songs.length === 7385, `buildIndex 成功: ${idx.songs.length} 首`);

// ③ 用前端代码查"人耳那句"与"原谱那句"
for (const [q, want] of [['33565653253', '神々が恋した幻想郷'], ['63731232', '神々が恋した幻想郷']]) {
  const res = search(idx, [parseQuery(q)], {});
  const top = res[0];
  ok(!!top && top.title.startsWith(want), `${q} -> Top1 "${top && top.title}" 代价 ${top && top.cost}`);
}

// ④ 部署的数据确实是修好的那份(th10_06 应为 415 音)
const th = idx.songs.find((s) => String(s.file).includes('th10_06'));
ok(th && th.n === 415, `th10_06 音符数 = ${th && th.n} (期望 415)`);
console.log(`\n${fail === 0 ? '通过' : '失败 ' + fail + ' 项'}  —— ${BASE}`);
process.exit(fail ? 1 : 0);
