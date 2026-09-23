// node tools/check_ui.mjs [查询] [按曲名查询] —— 真跑一遍"表单提交 → run() → render() → 结果卡 HTML"。
// 与 check_page.mjs 的区别: check_page 直接调 search(), 绕过了 render(); 这个脚本会
// 捕获 app.js 注册的事件处理器并**真的触发一次查询**, 所以 render() 里的运行时错误藏不住。
// (URL 参数会被忽略 —— 本脚本读本地 data/, 只为与 check_all.sh 的其他脚本统一调用方式。)
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
const argv = process.argv.slice(2).filter((a) => !/^https?:\/\//.test(a));
const QUERY = argv[0] || '33565653253';
const TQUERY = argv[1] || '神々';

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
mkEl('tq').value = TQUERY;
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

// ---- 投稿表单: 客户端必须把字段(尤其是"纠错目标")正确送出去 ----
// 2026-09-24 实测的坑: fix/meta 不告诉作者改哪一份 -> 作者收到"这首转错了"却不知道指哪首。
const posts = [];
const prevFetch = global.fetch;
global.fetch = async (u, opt) => {
  if (String(u).includes('/api/submit')) {
    const body = JSON.parse(opt.body);
    posts.push(body);
    return {
      ok: true, status: 200,
      json: async () => ({
        ok: true, id: 'T1', score_file: body.score ? '投稿测试曲.txt' : '', committed: true,
        refresh: !!body.score, refresh_msg: '已开始重建(约 2 分钟)',
        score_warn: /[a-zA-Z\u4e00-\u9fa5]/.test(body.score || '') ? '有字符没认出来丢了' : '',
      }),
    };
  }
  return prevFetch(u, opt);
};
const sf = handlers['sform'] && handlers['sform'].submit;
ok(!!sf, 'app.js 给 #sform 注册了 submit 处理器');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (sf) {
  mkEl('skind').value = 'new';
  mkEl('stitle').value = '投稿测试曲';
  mkEl('sscore').value = '63731232';
  mkEl('snote').value = '说明文字';
  mkEl('scontact').value = 'me@example.com';
  sf({ preventDefault() {} });
  await sleep(120);
  const p0 = posts[0] || {};
  ok(p0.kind === 'new' && p0.title === '投稿测试曲' && p0.score === '63731232'
     && p0.note === '说明文字' && p0.contact === 'me@example.com', 'new: 各字段都送到了');
  ok(p0.file === '', 'new: 不带"纠错目标"');
  ok(/T1/.test(mkEl('sstatus').textContent) && /投稿测试曲\.txt/.test(mkEl('sstatus').textContent),
     '成功提示里有编号和生成的曲谱名');
  ok(/重建/.test(mkEl('sstatus').textContent), '成功提示里说了索引在重建');

  // 纠错/元数据: 必须自动带上"刚才查询命中的那一份"
  mkEl('skind').value = 'fix';
  mkEl('stitle').value = '神々が恋した幻想郷';
  mkEl('sscore').value = '1 2 3 4 5';
  sf({ preventDefault() {} });
  await sleep(120);
  // 期望值从**渲染出来的卡片**里取(补收录页按钮上的 data-file), 不写死曲名
  const mfile = (out.match(/class="al-go" data-file="([^"]+)"/) || [])[1] || '';
  ok(!!mfile, '结果卡里能取到文件名(用于与投稿目标比对): ' + mfile);
  const p1 = posts[1] || {};
  ok(p1.kind === 'fix' && p1.file === mfile,
     'fix: 自动带上了刚才查询命中的文件(' + (p1.file || '空') + ', 期望 ' + mfile + ')');
  mkEl('skind').value = 'meta';
  mkEl('stitle').value = mkEl('stitle').value || '神々';   // 提交成功后表单会清空曲名, 这里重新填上
  sf({ preventDefault() {} });
  await sleep(120);
  ok((posts[2] || {}).file === mfile, 'meta: 同样带上了目标文件');

  // 认不出的字符 -> 警告必须透传到界面(不能悄悄吞掉)
  mkEl('skind').value = 'new';
  mkEl('stitle').value = '垃圾输入曲';
  mkEl('sscore').value = 'abc';
  sf({ preventDefault() {} });
  await sleep(120);
  ok(/没认出来/.test(mkEl('sstatus').textContent), '认不出的字符有警告提示');

  // 空曲名: 本地就该拦住, 不要白发一次请求
  const n = posts.length;
  mkEl('stitle').value = '';
  sf({ preventDefault() {} });
  await sleep(120);
  ok(posts.length === n && /请填曲名/.test(mkEl('sstatus').textContent), '空曲名本地拦住, 不发请求');
}

console.log(fail === 0 ? '\nUI 渲染自检 通过' : `\nUI 渲染自检 失败 ${fail} 项`);
process.exitCode = fail ? 1 : 0;
