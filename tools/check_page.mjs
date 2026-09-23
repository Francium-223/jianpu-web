// node tools/check_page.mjs [查询] —— 用假 DOM 执行 app.js, 看有没有运行时错误 +
//   结果卡是否真的渲染出元数据 + **命中段高亮/小节线画得对不对**。
// 默认查询 63731232; 传 `33565653253` 可复现"th10_06 开头休止被误标黑"那个 bug 的回归测试。
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
const QUERY = process.argv[2] || '63731232';

// ---- 假 DOM ----
const handlers = {};
const els = {};
function mkEl(id) {
  return els[id] || (els[id] = {
    id, _html: '', textContent: '', className: '', value: '', disabled: false, checked: true,
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = v; },
    addEventListener() {}, focus() {}, getAttribute() { return ''; },
  });
}
global.document = {
  getElementById: mkEl,
  getElementsByClassName: () => [],
  querySelectorAll: () => [],
  // app.js 用全局委托接「＋ 补收录页」的保存按钮(结果区有两个: #out / #tout)
  addEventListener(ev, fn) { (handlers['document'] = handlers['document'] || {})[ev] = fn; },
};
global.window = global;
global.location = { protocol: 'http:', host: '127.0.0.1:8770' };
global.performance = { now: () => Date.now() };
global.fetch = async (u) => {
  if (u.endsWith('songs.jsonl.gz')) {
    const buf = readFileSync(new URL('../data/songs.jsonl.gz', import.meta.url));
    return { ok: true, body: new Response(buf).body, json: async () => ({}) };
  }
  if (u.endsWith('stats.json')) {
    return { ok: true, json: async () => JSON.parse(readFileSync(new URL('../data/stats.json', import.meta.url), 'utf8')) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};
global.DecompressionStream = (await import('node:stream/web')).DecompressionStream;

process.on('unhandledRejection', (e) => { console.error('!! 未处理的 Promise 拒绝:', e && e.message); process.exitCode = 1; });
process.on('uncaughtException', (e) => { console.error('!! 未捕获异常:', e && e.message); process.exitCode = 1; });

await import('../static/app.js');
await new Promise((r) => setTimeout(r, 1200));
console.log('status 文本:', (mkEl('status').textContent || '(空)').slice(0, 80));

// 触发一次查询(直接调 run 不可达, 改为手动走一遍同一路径)
const { buildIndex, search } = await import('../static/search.js');
const { parseQuery, parseToken, isPitch } = await import('../static/jptok.js');
const app = await import('../static/app.js');
const idx = buildIndex(gunzipSync(readFileSync(new URL('../data/songs.jsonl.gz', import.meta.url))).toString('utf8'));
const q = parseQuery(QUERY);
const res = search(idx, [q], { top: 2 });
console.log('查询:', QUERY, '-> 检索结果数:', res.length);
const r = res[0];
console.log('第一首:', r.group, '| 代价', r.cost, '| 命中位置(音符下标)', r.at);
console.log('元数据字段是否齐:',
  ['file', 'tags', 'usertags', 'alias', 'transcriber', 'mbid', 'bars', 'bpb']
    .map((k) => k + '=' + (r[k] === undefined ? '缺!' : 'ok')).join(' '));
console.log('bars 数:', (r.bars || []).length, ' bpb:', r.bpb, ' 文件:', r.file);

// ---- 高亮/小节线自检: 标黑的必须是**有音高**的音符, 且逐个对上查询 ----
const html = app.renderScore(r.raw, r.at, q.length, r.bars);
const m = html.match(/<mark>([\s\S]*?)<\/mark>/);
let fail = 0;
const ok = (c, msg) => { console.log((c ? '✓ ' : '✗ ') + msg); if (!c) fail++; };
ok(!!m, '渲染出了 <mark> 命中段');
if (m) {
  const marked = m[1].replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean);
  const pitches = marked.filter(isPitch);
  ok(pitches.length === q.length, `标黑 token ${marked.length} 个, 其中有音高 ${pitches.length} 个 (期望 ${q.length})`);
  const bad = marked.filter((t) => parseToken(t) && !isPitch(t));
  ok(bad.length === 0, `标黑段里没有休止/念白 (发现: ${bad.join(' ') || '无'})`);
  const got = pitches.map((t) => parseToken(t).d).join('');
  const want = q.map((x) => x.d).join('');
  ok(got === want, `标黑的音 = 查询  (${got} vs ${want})`);
  console.log('  标黑段:', pitches.join(' '));
}
// 第一条小节线落在第几个音符之前 —— 必须与数据一致
const firstBarTok = (r.raw || '').split(' ');
let ni = -1, tokOfNote = {};
for (let i = 0; i < firstBarTok.length; i++) { if (isPitch(firstBarTok[i])) tokOfNote[++ni] = i; }
const b0 = (r.bars || [])[0];
console.log(`  数据第一条小节线: 在第 ${b0} 个音符之前 -> 显示时画在 raw[${tokOfNote[b0]}] = ${firstBarTok[tokOfNote[b0]]} 之前`);

// ---- 收录页自检(用户口径: 要"具体收录的那一页", 不要搜索页冒充) ----
const with_src = idx.songs.find((s) => s.srcurl && (s.links || []).length === 0);
const no_src = idx.songs.find((s) => !s.srcurl && !(s.links || []).length);
function fake(s, extra) {
  return Object.assign({ title: s.title, group: s.group, file: s.file, mbid: '',
                         srcurl: s.srcurl, links: s.links || [], source: s.source }, extra || {});
}
if (with_src) {
  const h = app.exactLinks(fake(with_src));
  ok(h.includes('class="exact"') && h.includes(with_src.srcurl),
     `有原谱站确切页时渲染出精确链接 (${with_src.srcurl})`);
  ok(h.includes('待补充：') && /网易云音乐/.test(h),
     '只有原谱站页时, 点名还缺哪几个平台(待补充：网易云音乐/…)');
  ok(!h.includes('收录页：待补充'), '已经有确切页时不再显示笼统的"收录页：待补充"');
}
if (no_src) {
  const h = app.exactLinks(fake(no_src));
  ok(h.includes('收录页：待补充'), `一条确切页都没有时显示"收录页：待补充" (${no_src.title})`);
}
{
  const all = fake(no_src || with_src, { srcurl: 'http://www.jianpu.cn/pu/15/150657.htm', links: [
    'https://music.163.com/song?id=186016', 'https://y.qq.com/n/ryqq/songDetail/0039MnYb0qxYhV',
    'https://www.bilibili.com/video/BV1xx411c7mD', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'] });
  const h = app.exactLinks(all);
  ok(h.includes('网易云音乐') && h.includes('YouTube') && h.includes('song?id=186016'),
     '人工补的 links 会渲染成精确链接(站名由 host 认出来)');
  ok(!h.includes('待补充'), '四个平台都补齐后不再显示"待补充"');
}
const sh = app.searchLinks(fake(with_src || no_src));
ok(/search|results/.test(sh) && !sh.includes('class="exact"'),
   '搜索链接那一行确实都是搜索 URL(与"收录页"分开渲染)');
console.log(fail === 0 ? '\n高亮+收录页 自检 通过' : `\n高亮+收录页 自检 失败 ${fail} 项`);
if (fail) process.exitCode = 1;
