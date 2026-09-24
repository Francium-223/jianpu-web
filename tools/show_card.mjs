// node tools/show_card.mjs <按曲名找的关键词> [显示几张=1] —— 把**真实渲染出来的卡片**打成文字。
// 为什么需要: 卡片的字段越来越多(文件/曲名/歌手/状态/…/收录页), 光看自检的 ✓ 不够,
// 想确认"加了 artist 之后长什么样"就得把渲染结果打出来看。
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const Q = process.argv[2] || '丑八怪';
const N = Number(process.argv[3] || 1);
const els = {}, handlers = {};
function mkEl(id) {
  return els[id] || (els[id] = {
    id, _html: '', textContent: '', className: '', value: '', disabled: false, checked: true,
    get innerHTML() { return this._html; }, set innerHTML(v) { this._html = v; },
    addEventListener(ev, fn) { (handlers[id] = handlers[id] || {})[ev] = fn; },
    focus() {}, getAttribute() { return ''; }, closest() { return null; },
    querySelector() { return mkEl(id + '-q'); }, querySelectorAll() { return []; },
  });
}
global.document = { getElementById: mkEl, getElementsByClassName: () => [], querySelectorAll: () => [],
  addEventListener(ev, fn) { (handlers['document'] = handlers['document'] || {})[ev] = fn; } };
global.window = global;
global.location = { protocol: 'http:', host: '127.0.0.1:8770' };
global.performance = { now: () => Date.now() };
global.fetch = async (u) => {
  if (String(u).endsWith('songs.jsonl.gz')) {
    return { ok: true, body: new Response(readFileSync(new URL('../data/songs.jsonl.gz', import.meta.url))).body, json: async () => ({}) };
  }
  if (String(u).endsWith('stats.json')) {
    return { ok: true, json: async () => JSON.parse(readFileSync(new URL('../data/stats.json', import.meta.url), 'utf8')) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};
global.DecompressionStream = (await import('node:stream/web')).DecompressionStream;
await import('../static/app.js');
await new Promise((r) => setTimeout(r, 1200));

mkEl('tq').value = Q;
const h = handlers['tform'] && handlers['tform'].submit;
if (!h) { console.error('app.js 没给 #tform 注册处理器'); process.exit(1); }
h({ preventDefault() {} });
const out = mkEl('tout').innerHTML;
const cards = out.split('<div class="card').slice(1);
console.log(`【按曲名找「${Q}」】${mkEl('tstatus').textContent}  ->  ${cards.length} 张卡`);
for (const c of cards.slice(0, N)) {
  const title = (c.match(/class="title">([^<]*)/) || [])[1] || '?';
  const cost = (c.match(/class="cost c\d">([^<]*)/) || [])[1] || '';
  console.log(`\n■ ${title}   ${cost}`);
  const tbl = (c.match(/<table class="meta">([\s\S]*?)<\/table>/) || [])[1] || '';
  for (const m of tbl.matchAll(/<th>([^<]*)<\/th><td>([\s\S]*?)<\/td>/g)) {
    const v = m[2].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    console.log('   ' + (m[1] + '：').padEnd(6) + v);
  }
  const lk = (c.match(/class="lab">收录页<\/span>([\s\S]*?)(?:<\/p>|<\/div>)/) || [])[1] || '';
  console.log('   收录页：' + lk.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80));
}
