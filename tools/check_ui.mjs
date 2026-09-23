// node tools/check_ui.mjs [查询] —— 真跑一遍"表单提交 → run() → render() → 结果卡 HTML"。
// 与 check_page.mjs 的区别: check_page 直接调 search(), 绕过了 render(); 这个脚本会
// 捕获 app.js 注册的事件处理器并**真的触发一次查询**, 所以 render() 里的运行时错误藏不住。
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
const QUERY = process.argv[2] || '33565653253';

const els = {}, handlers = {};
function mkEl(id) {
  return els[id] || (els[id] = {
    id, _html: '', textContent: '', className: '', value: '', disabled: false, checked: true,
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = v; },
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
    const buf = readFileSync(new URL('../data/songs.jsonl.gz', import.meta.url));
    return { ok: true, body: new Response(buf).body, json: async () => ({}) };
  }
  if (String(u).endsWith('stats.json')) {
    return { ok: true, json: async () => JSON.parse(readFileSync(new URL('../data/stats.json', import.meta.url), 'utf8')) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};
global.DecompressionStream = (await import('node:stream/web')).DecompressionStream;
let errors = [];
process.on('unhandledRejection', (e) => errors.push('未处理的 Promise 拒绝: ' + (e && e.message)));
process.on('uncaughtException', (e) => errors.push('未捕获异常: ' + (e && e.message)));

await import('../static/app.js');
await new Promise((r) => setTimeout(r, 1500));
mkEl('q').value = QUERY;
const h = handlers['form'] && handlers['form'].submit;
if (!h) { console.error('!! app.js 没有给 #form 注册 submit 处理器'); process.exit(1); }
try {
  h({ preventDefault() {} });
} catch (e) {
  errors.push('run() 抛异常: ' + e.message);
}
await new Promise((r) => setTimeout(r, 800));

const status = mkEl('status').textContent;
const out = mkEl('out').innerHTML;
console.log('status :', status.slice(0, 120));
console.log('#out 长度:', out.length);
let fail = 0;
const ok = (c, m) => { console.log((c ? '✓ ' : '✗ ') + m); if (!c) fail++; };
ok(!errors.length, '没有运行时错误' + (errors.length ? ' -> ' + errors.join(' | ') : ''));
ok(out.length > 200, '#out 真的渲染出了内容');
ok(!/undefined|NaN|\[object Object\]/.test(out), 'HTML 里没有 undefined / NaN / [object Object]');
for (const [name, re] of [['卡片', /class="card/], ['标黑', /<mark>/], ['收录页那行', /class="lab">收录页/],
                          ['待补充或精确链接', /(class="exact"|待补充)/], ['去找这一页', /去找这一页/],
                          ['补收录页表单', /class="addlink"/], ['小节线', /class="bar"/]]) {
  ok(re.test(out), '结果卡里有「' + name + '」');
}
// 把卡片开头一小段打出来, 方便肉眼核对
const i = out.indexOf('<div class="links">');
console.log('\n链接区 HTML:\n', out.slice(i, i + 900).replace(/></g, '>\n<'));

// ---- 「按曲名找」也要能真的渲染(补收录页/标签的工作流入口) ----
mkEl('tq').value = process.argv[3] || '神々';
const th = handlers['tform'] && handlers['tform'].submit;
ok(!!th, 'app.js 给 #tform 注册了 submit 处理器');
if (th) {
  th({ preventDefault() {} });
  const tout = mkEl('tout').innerHTML;
  ok(mkEl('tstatus').textContent.includes('命中'), '按曲名找到了: ' + mkEl('tstatus').textContent.slice(0, 60));
  ok(/class="card/.test(tout), '按曲名结果渲染出了卡片');
  for (const [name, re] of [['收录页行', /class="lab">收录页/], ['待补充或精确链接', /(class="exact"|待补充)/],
                            ['补收录页表单', /class="addlink"/], ['补标签表单', /class="al-go-tags"/]]) {
    ok(re.test(tout), '按曲名卡片里有「' + name + '」');
  }
}
// 标签词表(<datalist> 在页面里, 不在卡片 HTML 里) —— 检查它真的被语料词表灌满了
const tl = mkEl('taglist');
const nopt = (tl.innerHTML.match(/<option/g) || []).length;
ok(nopt > 50, '#taglist 已灌入语料标签词表(' + nopt + ' 个)');

console.log(fail === 0 ? '\nUI 渲染自检 通过' : `\nUI 渲染自检 失败 ${fail} 项`);
process.exitCode = fail ? 1 : 0;
