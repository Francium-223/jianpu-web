// node tools/check_tune.mjs —— 「每谱一页」(`/s/<id>`) 的自检。
//
// 用户口径(2026-09-24): "每张谱都有一个单独的页面, 显示它的原图, 像 abcnotation 那样"。
// 这个脚本**真跑一遍 app.js 的路由**: 把 location 摆成深链 `/s/<id>`, 让 app.js 自己渲,
// 然后检查渲出来的 HTML —— 原图地址/尺寸、元数据、收录页、原文小节线、没有原图的那首怎么说、
// 不存在的 id 怎么说、回首页能不能切回来。纯本地(读 data/), 不联网。
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const songsBuf = readFileSync(new URL('../data/songs.jsonl.gz', import.meta.url));
const imgBuf = readFileSync(new URL('../data/images.jsonl.gz', import.meta.url));
const rows = gunzipSync(songsBuf).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const imgs = new Map(gunzipSync(imgBuf).toString('utf8').split('\n').filter(Boolean)
  .map((l) => { const r = JSON.parse(l); return [r.s, r]; }));

// 挑样本: 一首**有多页原图**(且原文没被截断, 这样小节线能全数对上)的,
// 一首**没有原图**的, 一个不存在的 id
const has2 = (r) => r.s && imgs.has(r.s) && imgs.get(r.s).pg.length >= 2 && !imgs.get(r.s).drv;
const WITH = rows.find((r) => has2(r) && !r.trunc) || rows.find(has2);
const TRUNC = rows.find((r) => r.trunc && imgs.has(r.s));
const NOIMG = rows.find((r) => !(r.s && imgs.has(r.s)));
const BADID = '__no_such_tune__';
if (!WITH || !NOIMG) { console.error('!! 语料里找不到自检用的样本(有原图的 / 没原图的)'); process.exit(1); }

// ---- 假 DOM(与 check_page.mjs 同一套路, 多支持 hidden / popstate / closest) ----
const els = {}, handlers = {};
function mkEl(id) {
  return els[id] || (els[id] = {
    id, _html: '', textContent: '', className: '', value: '', hidden: false, disabled: false,
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = v; },
    addEventListener(ev, fn) { (handlers[id] = handlers[id] || {})[ev] = fn; },
    focus() {}, getAttribute() { return ''; }, closest() { return null; },
    querySelector() { return mkEl(id + '-q'); }, querySelectorAll() { return []; },
  });
}
global.document = {
  getElementById: mkEl, getElementsByClassName: () => [], querySelectorAll: () => [],
  addEventListener(ev, fn) { (handlers['document'] = handlers['document'] || {})[ev] = fn; },
};
global.window = global;
global.addEventListener = (ev, fn) => { (handlers['window'] = handlers['window'] || {})[ev] = fn; };
global.location = { protocol: 'http:', host: '127.0.0.1:8770',
                    pathname: '/s/' + WITH.id, hash: '', search: '' };
global.history = { pushState() {} };
global.scrollTo = () => {};
global.performance = { now: () => Date.now() };
global.fetch = async (u) => {
  const s = String(u);
  if (s.endsWith('songs.jsonl.gz')) return { ok: true, body: new Response(songsBuf).body, json: async () => ({}) };
  if (s.endsWith('images.jsonl.gz')) return { ok: true, body: new Response(imgBuf).body, json: async () => ({}) };
  if (s.endsWith('stats.json')) {
    return { ok: true, json: async () => JSON.parse(readFileSync(new URL('../data/stats.json', import.meta.url), 'utf8')) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};
global.DecompressionStream = (await import('node:stream/web')).DecompressionStream;
const errors = [];
process.on('unhandledRejection', (e) => errors.push('未处理的 Promise 拒绝: ' + (e && e.message)));
process.on('uncaughtException', (e) => errors.push('未捕获异常: ' + (e && e.message)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await import('../static/app.js');
await sleep(1800);

let fail = 0;
const ok = (c, m) => { console.log((c ? '✓ ' : '✗ ') + m); if (!c) fail++; };
const pop = () => { handlers['window'] && handlers['window'].popstate && handlers['window'].popstate(); };

// ---- ① 深链 /s/<id> ----
const im = imgs.get(WITH.s);
const html = mkEl('tune').innerHTML;
console.log(`样本: ${WITH.id} 「${WITH.g}」 · source=${WITH.s} · ${im.pg.length} 页 @ ${im.d}`);
ok(mkEl('home').hidden === true && mkEl('tune').hidden === false, '深链进来时首页藏起、谱页显示');
ok(html.includes(WITH.g || WITH.t), '标题渲出来了');
ok(/class="tune-h1"/.test(html) && /class="crumb"/.test(html), '有标题与"回检索"面包屑');
ok(/class="meta"/.test(html) && /<th>歌手<\/th>/.test(html) && /<th>状态<\/th>/.test(html),
   '侧栏是完整的元数据表(歌手/状态都在)');
ok(html.includes(WITH.id), '页面上写明了这一页的 id');
// **原图**: 地址要落在 /img/ 上、宽高要与索引一致、多页要一页一张
const imgs_ = [...html.matchAll(/<img src="([^"]+)" width="(\d+)" height="(\d+)"/g)];
ok(imgs_.length === im.pg.length, `原图张数 = 索引页数 (${imgs_.length} / ${im.pg.length})`);
ok(imgs_.every((m) => /\/img\//.test(m[1])), '原图地址都走 /img/ 前缀');
ok(imgs_.every((m, i) => +m[2] === im.pg[i][1] && +m[3] === im.pg[i][2]),
   '每张图的 width/height 与索引里的实际像素一致(不会排版抖动)');
ok(imgs_.every((m, i) => m[1].includes(encodeURIComponent(im.pg[i][0]))), '文件名逐段编码(中文/空格目录也能取到)');
ok(/class="exact"/.test(html), '收录页(确切页面)片子还在');
ok(/class="exact pending"/.test(html) && /class="plus"/.test(html), '未收录的平台照旧是黄片 + 圆形 ＋');
ok(/class="al-go" data-file="[^"]+" data-re="tune"/.test(html), '保存链接后会回到**本页**重渲(data-re="tune")');
ok(/class="al-go-tags"/.test(html), '谱页上也能补标签');
ok(!/class="tune-link"/.test(html), '谱页上不再出现"本谱一页"那颗片子(自己指自己没意义)');
// 原文: 画小节线, 但**不能**有标黑段(那是检索结果的"命中段")
ok(/class="bar"/.test(html), '原文里画出了小节线');
ok(!/<mark>/.test(html), '原文里没有标黑段(整首谱没有"命中段")');
ok(html.includes(WITH.file[0]), '写明了曲谱文件名(补录/纠错要用它)');

// renderScore(raw, null, …) 直接验一遍: 只画线不标黑
const app = await import('../static/app.js');
const { isPitch } = await import('../static/jptok.js');
const rs = app.renderScore(WITH.raw, null, 0, WITH.bars);
ok(/class="bar"/.test(rs) && !/<mark>/.test(rs), 'renderScore(at=null) = 只画小节线');
// 期望值要按**这份 raw 里真有的音符**算: raw 长过 400 个 token 时被截断(trunc), 而 bars 是全曲的,
// 截断之外的线当然画不出来; bars 里也可能有重复下标(同一个音符前标了两次), 画出来只有一条。
const nNotesRaw = WITH.raw.split(' ').filter(isPitch).length;
const expBars = new Set(WITH.bars.filter((b) => b >= 0 && b < nNotesRaw)).size;
const gotBars = (rs.match(/class="bar"/g) || []).length;
ok(gotBars === expBars,
   `小节线数量 = 可达且去重后的 bars 条数 (${gotBars} / ${expBars}; raw ${nNotesRaw} 音, trunc=${!!WITH.trunc})`);
ok(!!WITH.trunc === /只显示前 400 个 token/.test(html), '原谱被截断时页面上说明了(trunc=' + !!WITH.trunc + ')');

// 真被截断的那一首(如果有): 页面上必须说清楚, 别让人以为原文就这么多
if (TRUNC) {
  location.pathname = '/s/' + TRUNC.id;
  pop();
  await sleep(400);
  const ht = mkEl('tune').innerHTML;
  ok(/只显示前 400 个 token/.test(ht), `原文被截断时说明了(${TRUNC.id})`);
}

// ---- ② 没有原图的那首: 要明说, 不要留碎图 ----
location.pathname = '/s/' + NOIMG.id;
pop();
await sleep(400);
const h2 = mkEl('tune').innerHTML;
console.log(`没原图的样本: ${NOIMG.id} 「${NOIMG.g}」`);
ok(h2.includes(NOIMG.g) && /还没存下原图/.test(h2), '没有原图时明说"还没存下原图"');
ok(!/<img /.test(h2), '没有原图时不放空 img 标签');
ok(/class="meta"/.test(h2), '没有原图也照样有元数据/收录页');

// ---- ③ 不存在的 id ----
location.pathname = '/s/' + BADID;
pop();
await sleep(300);
ok(/没有这一页/.test(mkEl('tune').innerHTML), '不存在的 id 有明确说明(而不是白屏)');

// ---- ④ hash 形式(纯静态托管没有 SPA 回退时用它) ----
location.pathname = '/';
location.hash = '#/s/' + WITH.id;
pop();
await sleep(400);
ok((mkEl('tune').innerHTML || '').includes(WITH.g), '#/s/<id> 这种形式也能打开');

// ---- ⑤ 回首页 ----
location.hash = '';
location.pathname = '/';
pop();
await sleep(200);
ok(mkEl('home').hidden === false && mkEl('tune').hidden === true, '回首页后首页显示、谱页藏起');
ok(document.title.includes('简谱旋律查歌'), '标题回到站点名');

ok(!errors.length, '全程没有运行时错误' + (errors.length ? ' -> ' + errors.join(' | ') : ''));
console.log(fail === 0 ? '\n每谱一页 自检 通过' : `\n每谱一页 自检 失败 ${fail} 项`);
process.exitCode = fail ? 1 : 0;
