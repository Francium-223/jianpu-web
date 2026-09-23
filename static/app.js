import { buildIndex, search } from './search.js';
import { parseQuery, parseToken, isPitch, show } from './jptok.js';

/* 数据侧: 只需要"曲名 + 出处" 就能给出可点的外链 —— 不依赖任何 API/key */
var REPO = 'Francium-223/jianpu-db';

function $(id) { return document.getElementById(id); }
var IDX = null;

function loadCorpus() {
  if (typeof DecompressionStream === 'undefined') {
    return fetch('/data/songs.jsonl').then(function (r) { return r.text(); });
  }
  return fetch('/data/songs.jsonl.gz').then(function (r) {
    return new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).text();
  });
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

function sourceUrl(src) {
  var host = String(src || '').split('-')[0];
  var m = { qupu123: 'https://www.qupu123.com/', jianpucn: 'http://www.jianpu.cn/',
            jianpujia: 'https://www.jianpujia.com/' };
  return m[host] || '';
}

/* 站点标签: 从 URL 的 host 认(不靠人的命名习惯) */
var SITE_LABELS = [
  [/music\.163\.com/, '网易云音乐'],
  [/y\.qq\.com/, 'QQ音乐'],
  [/bilibili\.com/, 'B站'],
  [/youtube\.com|youtu\.be/, 'YouTube'],
  [/musicbrainz\.org/, 'MusicBrainz'],
  [/jianpu\.cn/, '歌谱简谱网'],
  [/jianpujia\.com/, '简谱之家'],
  [/qupu123\.com/, '中国曲谱网'],
  [/qinyipu\.com/, '琴艺谱'],
];
function siteLabel(u) {
  for (var i = 0; i < SITE_LABELS.length; i++) if (SITE_LABELS[i][0].test(u)) return SITE_LABELS[i][1];
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return '链接'; }
}

/* **收录页**: 这首歌在那一站的**具体页面**。
 *   来源 = 人工补的 `link=`(可多个) + 原谱站核对过的具体页(srcurl) + MBID 对应的 MusicBrainz 录音页。
 * 用户口径(2026-09-23): 「我要的不是个自动跳转到搜索页面的按钮, 我要的是跳转到它具体收录的那一页」
 *   —— 所以这里**只放确切页面**; 搜索页由下面的 searchLinks() 单独一行, 明确标成"去找这一页"。
 *   一条都没有时, 显示"收录页：待补充"(而不是拿搜索按钮冒充)。 */
export function exactLinks(r) {
  var out = [], seen = {};
  function push(u, kind) {
    if (!u || seen[u]) return;
    seen[u] = 1;
    out.push([siteLabel(u), u, kind]);
  }
  if (r.mbid) push('https://musicbrainz.org/recording/' + encodeURIComponent(r.mbid), 'MBID');
  if (r.srcurl) push(r.srcurl, '原谱站（已核对）');
  (r.links || []).forEach(function (u) { push(u, '收录页'); });
  if (!out.length) {
    return '<span class="todo" title="这一首还没有人补它在各站的具体页面">收录页：待补充</span>';
  }
  var chips = out.map(function (p) {
    return '<a class="exact" href="' + p[1] + '" target="_blank" rel="noopener" title="' + esc(p[2]) +
      '">' + esc(p[0]) + ' ↗</a>';
  }).join('');
  // 缺的平台点名(用户要的"待补充"标记): 有页面但缺网易云/B站/YT 时, 直接说缺哪几个
  var pend = pendingPlatforms(r);
  return chips + (pend.length
    ? '<span class="todo" title="这几个站还没有确切页面, 等人补">待补充：' + esc(pend.join(' / ')) + '</span>'
    : '');
}

/* 四个"收录平台": 缺哪个就在"待补充"里点名(而不是笼统一句)。 */
var PLATFORMS = [
  ['网易云音乐', /music\.163\.com/],
  ['QQ音乐', /y\.qq\.com/],
  ['B站', /bilibili\.com/],
  ['YouTube', /youtube\.com|youtu\.be/],
];
function pendingPlatforms(r) {
  var urls = [];
  if (r.srcurl) urls.push(r.srcurl);
  (r.links || []).forEach(function (u) { urls.push(u); });
  return PLATFORMS.filter(function (p) {
    return !urls.some(function (u) { return p[1].test(u); });
  }).map(function (p) { return p[0]; });
}

/* 搜索链接: 只是"去找这一页"的工具 —— **不是**收录页, 不进语料。
 * 用户要求保留在结果卡里(配上面的"待补充"标记一起看)。 */
export function searchLinks(r) {
  var q = encodeURIComponent(r.title || r.group);
  var out = [
    ['网易云', 'https://music.163.com/#/search/m/?s=' + q + '&type=1'],
    ['QQ音乐', 'https://y.qq.com/n/ryqq/search?w=' + q],
    ['B站', 'https://search.bilibili.com/all?keyword=' + q],
    ['YouTube', 'https://www.youtube.com/results?search_query=' + q],
    ['MusicBrainz', 'https://musicbrainz.org/search?query=' + q + '&type=recording'],
  ];
  return out.map(function (p) {
    return '<a href="' + p[1] + '" target="_blank" rel="noopener">' + p[0] + '</a>';
  }).join('');
}

/* 「＋ 补收录页」: 人工把**具体页面**的网址粘进来 -> 写进 scores/<file>.txt 的 link= 并重建索引。
 * 这是"人为补充"的入口; 命令行批量入口是 jianpu2/tools/add_link.py。 */
function addLinkForm(r) {
  var f = (r.file && r.file[0]) || '';
  if (!f) return '';
  return '<details class="addlink"><summary>＋ 补收录页</summary>' +
    '<p class="hint">粘这首歌在某一站的<b>具体页面</b>网址（网易云 / QQ音乐 / B站 / YouTube…）。' +
    '搜索页会被拒收 —— 上面那行搜索链接只用来帮你找到页面。</p>' +
    '<input class="al-url" placeholder="https://music.163.com/song?id=…" spellcheck="false" />' +
    '<button class="al-go" data-file="' + esc(f) + '">保存</button>' +
    '<span class="al-msg"></span></details>';
}

/* 「＋ 库里没有这首」: 预填一个 GitHub Issue 表单, 点一下就能提(用户自己确认后提交) */
function issueUrl(text) {
  return 'https://github.com/' + REPO + '/issues/new?title=' +
    encodeURIComponent('[缺谱] ' + text) +
    '&body=' + encodeURIComponent(
      '想加的曲子:' + text + '\n\n' +
      '(可选) 原谱链接或图片:\n\n' +
      '(可选) 这段旋律的简谱数字:\n\n' +
      '---\n由简谱旋律查歌前端自动填写\n');
}

/* 把原谱原文渲染成 HTML, 并把"命中段"的 token 标黑。
 *
 * **必须用 isPitch 判"第几个音符"**: 索引里的 `at`/`bars`/`n` 数的是"第几个**有音高**的音符",
 * 而 raw 里混着休止/念白(`c0`/`q0`/`x`)、时值前缀、小节线 `|`、延长 `-`。
 * 这里踩过两次坑:
 *   ① 早先抄了一条**窄**正则, 把 `q3` 判成"不是音符" -> 高亮跑到别处(用户实测: 搜 623532 却标出 `q5 s5 q,5. …`);
 *   ② 后来改用 parseToken, 但它对 `c0`(休止)也返回非空 -> **休止被当成音符**,
 *      高亮与小节线整体前移(用户实测: th10_06 开头 `c0 q0` 被误标黑, 第一条 `|` 画到 `q3 q3` 之后)。
 * 口径只能有一份: jptok.isPitch。
 */
export function renderScore(raw, at, qlen, bars) {
  if (!raw) return '';
  var toks = raw.split(' ');
  var barSet = {};
  (bars || []).forEach(function (b) { barSet[b] = 1; });
  var noteIdx = -1, html = [], endTok = -1, startTok = -1;
  for (var i = 0; i < toks.length; i++) {
    if (isPitch(toks[i])) {
      noteIdx++;
      if (noteIdx === at) startTok = i;
      if (noteIdx === at + qlen - 1) endTok = i;
    }
  }
  if (startTok < 0) return esc(raw);
  if (endTok < 0) endTok = toks.length - 1;
  noteIdx = -1;
  for (var j = 0; j < toks.length; j++) {
    // 音节线画在"它之前的那条"位置: bars 里记的是音符下标
    var isNote = isPitch(toks[j]);
    if (isNote) noteIdx++;
    if (isNote && barSet[noteIdx] && j !== startTok) html.push('<span class="bar">|</span> ');
    if (j === startTok) html.push('<mark>');
    if (j === endTok + 1) html.push('</mark>');
    html.push(esc(toks[j]));
    if (j < toks.length - 1) html.push(' ');
  }
  if (endTok + 1 >= toks.length) html.push('</mark>');
  return html.join('');
}

function run(e) {
  if (e) e.preventDefault();
  if (!IDX) return;
  var segs = [];
  var parts = $('q').value.split(/[;；|、+，,]+/);
  for (var i = 0; i < parts.length; i++) {
    var s = parseQuery(parts[i]);
    if (s.length >= 5) segs.push(s);
  }
  if (!segs.length) {
    $('status').className = 'status err';
    $('status').textContent = '请至少输入 5 个音（只认 1-7；可带 # 或 b）。空格不分段，逗号/分号/竖线分段。';
    return;
  }
  $('status').className = 'status';
  $('status').textContent = '查询中…';
  $('go').disabled = true;
  setTimeout(function () {
    var t0 = performance.now();
    var res = search(IDX, segs, { top: 10 });
    render(segs, res, Math.round(performance.now() - t0));
    $('go').disabled = false;
  }, 20);
}

/* 元数据全摊开: 一行一项, 空的显示 — —— 用户要求"不光标题, 别的元数据也都一并摊开" */
/* 站点首页: 把 `qupu123-268596` 这类 source 映射回该站首页(源码站可点) */
function siteUrl(src) {
  var host = String(src || '').split('-')[0];
  var m = { qupu123: 'https://www.qupu123.com/', jianpucn: 'http://www.jianpu.cn/',
            jianpujia: 'https://www.jianpujia.com/' };
  return m[host] || '';
}

function metaRows(r) {
  function list(x) { return (x || []).join('、'); }
  var src = r.source || '';
  var srcUrl = r.srcurl || sourceUrl(src);      // 优先链到原谱站**那一页**, 没有再退回站点首页
  var rows = [
    ['文件', r.file && r.file.length ? esc(list(r.file)) : '—'],
    ['曲名', esc(r.group)],
    ['状态', esc(r.status || '?') + (r.status === 'ok' ? '（人工校对过）'
      : r.status === 'ocr' ? '（图片机器转写）' : '')],
    ['音符', r.n + ' 个'],
    ['小节', (r.bars || []).length + ' 小节 · ' + (r.bpb || 4) + ' 拍/小节'],
    ['出处', src ? (srcUrl
      ? '<a href="' + srcUrl + '" target="_blank" rel="noopener">' + esc(src) + '</a>'
      : esc(src)) : '—'],
    ['转写', r.transcriber && r.transcriber.length ? esc(list(r.transcriber)) : '—'],
    ['标签', r.tags && r.tags.length ? esc(list(r.tags)) : '—'],
    ['人标', r.usertags && r.usertags.length ? esc(list(r.usertags)) : '—'],
    ['别名', r.alias && r.alias.length ? esc(list(r.alias)) : '—'],
    ['MBID', r.mbid
      ? '<a href="https://musicbrainz.org/recording/' + encodeURIComponent(r.mbid) +
        '" target="_blank" rel="noopener"><code>' + esc(r.mbid) + '</code></a>'
      : '—'],
  ];
  return '<table class="meta"><tbody>' +
    rows.map(function (x) { return '<tr><th>' + x[0] + '</th><td>' + x[1] + '</td></tr>'; }).join('') +
    '</tbody></table>';
}

function render(segs, res, ms) {
  var qshow = segs.map(show).join('  |  ');
  if (!res.length) {
    $('status').textContent = '没找到匹配（' + ms + ' 毫秒）。片段至少 5 个音；换更长的片段试试。';
    $('out').innerHTML = '<p class="hint">如果确认库里应该没有这首歌，点这里告诉作者：' +
      '<span class="links"><a class="add" href="' + issueUrl(qshow) + '" target="_blank" rel="noopener">＋ 建议收录</a></span></p>';
    return;
  }
  var tied = 0;
  for (var i = 0; i < res.length; i++) if (res[i].cost === res[0].cost) tied++;
  $('status').textContent = '查询 ' + qshow + '：命中 ' + res.length + ' 组，用时 ' + ms + ' 毫秒' +
    (tied > 1 ? '；最优并列 ' + tied + ' 组（片段不够独特，加长或补第二段）' : '');

  var html = '';
  LAST = res[0].group;                 // 供"投稿"表单的「用刚才查询的曲名填入」
  for (var k = 0; k < res.length; k++) {
    var r = res[k];
    html += '<div class="card' + (k === 0 ? ' top' : '') + '">' +
      '<div class="head">' +
        (k === 0 ? '' : '<span class="rank">#' + (k + 1) + '</span>') +
        '<span class="title">' + esc(r.group) + '</span>' +
        '<span class="cost c' + Math.min(r.cost, 2) + '">代价 ' + r.cost + '</span>' +
        '<span class="badge">记号 ' + r.exact + '/' + r.qlen + '</span>' +
        '<span class="badge">' + r.n + ' 音符</span>' +
        '<span class="badge">' + esc(r.status || '?') + '</span>' +
      '</div>' +
      metaRows(r) +
      '<div class="cmp"><span class="lab">库内该段</span> ' + esc(show(r.libNotes)) +
        '　<span class="lab">你的输入</span> ' + esc(show(r.qNotes)) + '</div>' +
      '<div class="score">' + renderScore(r.raw, r.at, r.qlen, r.bars) + '</div>' +
      '<div class="links">' +
        '<span class="lab">收录页</span> ' + exactLinks(r) +
        '<span class="find"><span class="lab">去找这一页</span> ' + searchLinks(r) + '</span>' +
        addLinkForm(r) +
        '<a class="add" href="' + issueUrl(r.group) + '" target="_blank" rel="noopener" ' +
        'title="库里这首有问题 / 想补充资料 → 一键提 issue">＋ 反馈/补充</a>' +
      '</div></div>';
  }
  $('out').innerHTML = html +
    '<p class="hint">代价 0 = 连升降号都一致；你没写记号时对上带 #/b 的音记 1，' +
    '写了记号而库里是自然音记 2。“记号”是升降号完全一致的音数。' +
    '<b>收录页</b>是这首歌在那一站的<b>具体页面</b>（人工补的 + 原谱站核对过的）；' +
    '<b>去找这一页</b>只是帮你到各站搜出页面，本身不是收录链接。</p>';
}

$('form').addEventListener('submit', run);

/* ---------------- 「按曲名找」----------------
 * 为什么需要: 补收录页/标签、核对元数据时都是"对着某一首"操作, 而上面的旋律查歌得先知道旋律。
 * 这里只按本地索引(曲名/别名)过滤, 不联网; 卡片与旋律结果卡共用 metaRows / exactLinks 等,
 * 所以「收录页」「待补充」「＋补收录页」的行为完全一致。 */
function titleSearch(q) {
  var s = String(q || '').trim().toLowerCase();
  if (!s || !IDX) return [];
  var out = [];
  for (var i = 0; i < IDX.songs.length && out.length < 40; i++) {
    var x = IDX.songs[i];
    var hay = [x.title, x.group, (x.alias || []).join(' ')].join(' ').toLowerCase();
    if (hay.indexOf(s) >= 0) out.push(x);
  }
  return out;
}

function renderTitle(list, q) {
  if (!list.length) {
    $('tstatus').className = 'status err';
    $('tstatus').textContent = '按曲名没找到「' + q + '」。换个更短的关键词，或用上面的旋律查歌。';
    $('tout').innerHTML = '';
    return;
  }
  $('tstatus').className = 'status';
  $('tstatus').textContent = '按曲名「' + q + '」命中 ' + list.length + ' 首' +
    (list.length >= 40 ? '（只显示前 40 首，写更具体一点）' : '');
  var html = '';
  for (var k = 0; k < list.length; k++) {
    var x = list[k];
    html += '<div class="card">' +
      '<div class="head"><span class="title">' + esc(x.group || x.title) + '</span>' +
        '<span class="badge">' + x.n + ' 音符</span>' +
        '<span class="badge">' + esc(x.status || '?') + '</span>' +
      '</div>' + metaRows(x) +
      '<div class="links"><span class="lab">收录页</span> ' + exactLinks(x) +
        '<span class="find"><span class="lab">去找这一页</span> ' + searchLinks(x) + '</span>' +
        addLinkForm(x) + '</div>' +
      (x.raw ? '<div class="score">' + esc(x.raw) + '</div>' : '') +
      '</div>';
  }
  $('tout').innerHTML = html;
}

if ($('tform')) {
  $('tform').addEventListener('submit', function (ev) {
    ev.preventDefault();
    renderTitle(titleSearch($('tq').value), $('tq').value);
  });
}

/* 「＋ 补收录页」的保存: 走已有投稿接口 -> 服务端校验后把 link=<url> 写进 scores/<file>.txt
 * 并 git commit, 再重建索引。返回值里的 file/commit/refresh 用来给用户回话。 */
document.addEventListener('click', function (ev) {
  var b = ev.target && ev.target.closest ? ev.target.closest('.al-go') : null;
  if (!b) return;
  var box = b.closest('.addlink');
  var inp = box.querySelector('.al-url');
  var msg = box.querySelector('.al-msg');
  var url = (inp.value || '').trim();
  if (!url) { msg.className = 'al-msg err'; msg.textContent = '先粘贴网址'; return; }
  b.disabled = true;
  msg.className = 'al-msg';
  msg.textContent = '保存中…';
  fetch(API + '/api/submit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'link', file: b.getAttribute('data-file'), url: url }),
  }).then(function (r) { return r.json(); }).then(function (j) {
    b.disabled = false;
    if (j && j.ok) {
      msg.className = 'al-msg ok';
      msg.textContent = '已写入 ' + j.file + (j.committed ? '（已 git commit）' : '（未提交）') +
        (j.refresh ? '；' + (j.refresh_msg || '索引重建中，约 2 分钟后刷新可见') : '');
      inp.value = '';
    } else {
      msg.className = 'al-msg err';
      msg.textContent = '失败：' + ((j && j.err) || '未知错误');
    }
  }).catch(function (e) {
    b.disabled = false;
    msg.className = 'al-msg err';
    msg.textContent = '失败：' + e.message;
  });
});
var exs = document.getElementsByClassName('ex');
for (var i = 0; i < exs.length; i++) {
  exs[i].addEventListener('click', function (ev) {
    ev.preventDefault();
    $('q').value = this.getAttribute('data-q');
    run();
  });
}

/* ---------- 投稿(不用登录, 不碰 GitHub) ---------- */
var API = window.JIANPU_API || (location.protocol + '//' + location.host);   // 同源; 换服务器就设 window.JIANPU_API
var LAST = '';

function submit() {
  var t = $('stitle').value.trim();
  if (!t) { $('sstatus').className = 'status err'; $('sstatus').textContent = '请填曲名。'; return; }
  var body = {
    kind: $('skind').value, title: t,
    score: $('sscore').value.trim(), note: $('snote').value.trim(),
    contact: $('scontact').value.trim()
  };
  $('sstatus').className = 'status';
  $('sstatus').textContent = '提交中…';
  $('sgo').disabled = true;
  fetch(API + '/api/submit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }).then(function (r) { return r.json().then(function (j) { return { s: r.status, j: j }; }); })
    .then(function (x) {
      $('sgo').disabled = false;
      if (x.j && x.j.ok) {
        $('sstatus').textContent = '已收到，编号 ' + x.j.id +
          (x.j.score_file ? '（已生成曲谱 ' + x.j.score_file + ' 入库）' : '（只留了投稿，没有数字）');
        $('stitle').value = ''; $('sscore').value = ''; $('snote').value = '';
      } else {
        $('sstatus').className = 'status err';
        $('sstatus').textContent = '提交失败：' + ((x.j && x.j.err) || ('HTTP ' + x.s)) +
          '。可用 GitHub 兜底：<a href="' + issueUrl(t) + '" target="_blank" rel="noopener">打开预填 Issue</a>';
        $('sstatus').innerHTML = $('sstatus').textContent;
      }
    })
    .catch(function (e) {
      $('sgo').disabled = false;
      $('sstatus').className = 'status err';
      $('sstatus').innerHTML = '连不上投稿服务（' + e.message + '）。' +
        '可用 GitHub 兜底：<a href="' + issueUrl(t) + '" target="_blank" rel="noopener">打开预填 Issue</a>';
    });
}

$('sform').addEventListener('submit', function (e) { e.preventDefault(); submit(); });
$('sfill').addEventListener('click', function () {
  if (LAST) { $('stitle').value = LAST; }
  else { $('sstatus').textContent = '先在上面查一次，再点这个按钮。'; }
});

loadCorpus().then(function (txt) {
  IDX = buildIndex(txt);
  return fetch('/data/stats.json').then(function (r) { return r.json(); });
}).then(function (st) {
  $('stats').textContent = '语料 ' + st.songs + ' 首（' + st.groups + ' 个曲名组），' +
    st.notes.toLocaleString() + ' 个音符，含变音记号 ' + st.with_accidental + ' 首。';
  $('status').textContent = '就绪，共 ' + IDX.count + ' 首。';
  $('q').focus();
}).catch(function (err) {
  $('status').className = 'status err';
  $('status').textContent = '初始化失败：' + err.message;
});
