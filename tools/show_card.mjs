// node tools/show_card.mjs <按曲名找的关键词> [显示几张=1] —— 把**真实渲染出来的卡片**打成文字。
// 为什么需要: 卡片的字段越来越多(文件/曲名/歌手/状态/…/收录页), 光看自检的 ✓ 不够,
// 想确认"加了 artist 之后长什么样"就得把渲染结果打出来看。
// SHOW_TUNE=1 -> 顺便把**每谱一页**(/s/<id>) 的渲染结果也打出来: 原图几张/多大/什么地址,
//                收录页那一行, 原文小节线数。不开浏览器也能核对这一页的内容。
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
global.addEventListener = (ev, fn) => { (handlers['window'] = handlers['window'] || {})[ev] = fn; };
global.location = { protocol: 'http:', host: '127.0.0.1:8770', pathname: '/', hash: '', search: '' };
global.history = { pushState() {} };
global.performance = { now: () => Date.now() };
global.fetch = async (u) => {
  if (String(u).endsWith('songs.jsonl.gz')) {
    return { ok: true, body: new Response(readFileSync(new URL('../data/songs.jsonl.gz', import.meta.url))).body, json: async () => ({}) };
  }
  if (String(u).endsWith('images.jsonl.gz')) {      // 谱页要原图索引(不然会假报"盘上没有")
    return { ok: true, body: new Response(readFileSync(new URL('../data/images.jsonl.gz', import.meta.url))).body, json: async () => ({}) };
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
  const title = (c.match(/class="title[^"]*"[^>]*>([^<]*)/) || [])[1] || '?';
  const cost = (c.match(/class="cost c\d">([^<]*)/) || [])[1] || '';
  console.log(`\n■ ${title}   ${cost}`);
  const tid = (c.match(/data-tune="([^"]+)"/) || [])[1] || '';
  console.log('   本谱一页：/s/' + tid);
  const tbl = (c.match(/<table class="meta">([\s\S]*?)<\/table>/) || [])[1] || '';
  for (const m of tbl.matchAll(/<th>([^<]*)<\/th><td>([\s\S]*?)<\/td>/g)) {
    const v = m[2].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    console.log('   ' + (m[1] + '：').padEnd(6) + v);
  }
  // 收录页那一行: 已收录=绿片, 未收录=灰片+圆形＋(用户口径 2026-09-24)
  const lk = (c.match(/class="lab">收录页<\/span>([\s\S]*?)<span class="alrow"/) || [])[1] || '';
  let line = '';
  for (const m of lk.matchAll(/<a class="exact"[^>]*>([^<]*)<\/a>/g)) line += '[' + m[1].replace(' ↗', '') + ' ✓] ';
  const grey = [...lk.matchAll(/<a class="exact pending"[^>]*>([^<]*)<\/a>/g)].map((m) => m[1]);
  const plus = (lk.match(/class="plus"/g) || []).length;
  if (grey.length) line += grey.map((g) => '[' + g + ' 黄·可搜]＋').join(' ') + ' ';
  if (plus > grey.length) line += '[＋ 其它站]';
  console.log('   收录页：' + (line.trim() || '(无)'));
  if (process.env.SHOW_HREF) {   // SHOW_HREF=1 -> 把黄片指向的搜索链接也打出来
    for (const m of lk.matchAll(/<a class="exact pending" href="([^"]+)"/g)) {
      console.log('      ↳ ' + decodeURIComponent(m[1]).slice(0, 90));
    }
  }
}

// ---- SHOW_TUNE=1: 把第一张卡对应的「每谱一页」打成文字 ----
if (process.env.SHOW_TUNE) {
  const id = ((cards[0] || '').match(/data-tune="([^"]+)"/) || [])[1];
  if (!id) {
    console.log('\n(这张卡没有 id, 打不了谱页)');
  } else {
    global.location.pathname = '/s/' + id;
    const pop = handlers['window'] && handlers['window'].popstate;
    if (pop) pop();
    await new Promise((r) => setTimeout(r, 1500));
    const t = mkEl('tune').innerHTML;
    console.log(`\n【每谱一页 /s/${id}】  ${t.length} 字节 HTML`);
    console.log('  标题：' + ((t.match(/class="tune-h1">([^<]*)/) || [])[1] || '?'));
    console.log('  副行：' + ((t.match(/class="tune-sub">([\s\S]*?)<\/p>/) || [])[1] || '').replace(/<[^>]+>/g, '').trim());
    const figs = [...t.matchAll(/<img src="([^"]+)" width="(\d+)" height="(\d+)"/g)];
    if (figs.length) {
      console.log('  原图：' + figs.length + ' 页');
      figs.forEach((m, i) => console.log(`    第${i + 1}页 ${m[2]}x${m[3]}  ${decodeURIComponent(m[1]).slice(0, 100)}`));
      const alt = (t.match(/<p class="hint">另有：([\s\S]*?)<\/p>/) || [])[1];
      if (alt) console.log('  另有：' + alt.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160));
    } else {
      console.log('  原图：这首盘上没有存的扫描件');
    }
    const lk = (t.match(/class="lab">收录页<\/span>([\s\S]*?)<span class="alrow"/) || [])[1] || '';
    let line = '';
    for (const m of lk.matchAll(/<a class="exact"[^>]*>([^<]*)<\/a>/g)) line += '[' + m[1].replace(' ↗', '') + ' ✓] ';
    const grey = [...lk.matchAll(/<a class="exact pending"[^>]*>([^<]*)<\/a>/g)].map((m) => m[1]);
    if (grey.length) line += grey.map((g) => '[' + g + ' 黄·可搜]＋').join(' ') + ' ';
    console.log('  收录页：' + (line.trim() || '(无)'));
    console.log('  原文小节线：' + (t.match(/class="bar"/g) || []).length + ' 条；' +
                (t.match(/<mark>/g) || []).length + ' 处标黑(应为 0)');
  }
}
