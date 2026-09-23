import { buildIndex, search } from './search.js';
import { parseQuery, parseToken, show } from './jptok.js';

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

/* 外链: 用曲名去各站搜。全是普通搜索 URL, 不需要 key, 也不用我们的数据支持 */
function externalLinks(r) {
  var q = encodeURIComponent(r.title || r.group);
  var out = [];
  if (r.mbid) out.push(['MusicBrainz', 'https://musicbrainz.org/recording/' + r.mbid]);
  out.push(['MusicBrainz 搜', 'https://musicbrainz.org/search?query=' + q + '&type=recording']);
  out.push(['网易云', 'https://music.163.com/#/search/m/?s=' + q + '&type=1']);
  out.push(['QQ音乐', 'https://y.qq.com/n/ryqq/search?w=' + q]);
  out.push(['B站', 'https://search.bilibili.com/all?keyword=' + q]);
  out.push(['YouTube', 'https://www.youtube.com/results?search_query=' + q]);
  if (r.source && sourceUrl(r.source)) out.push(['原谱站', sourceUrl(r.source)]);
  return out.map(function (p) {
    return '<a href="' + p[1] + '" target="_blank" rel="noopener">' + p[0] + '</a>';
  }).join('');
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
 * **必须用 parseToken 判音符**, 不能自己写正则: 索引里的 `at` 是"第几个音符"的序号,
 * 而 raw 里混着时值前缀(展开后几乎是每个 token 都带 q/s 前缀)、小节线 `|`、延长 `-`。
 * 之前这里用了一条**抄窄了的**正则, 它把 `q3` 之类的 token 判成"不是音符",
 * 于是 notePos 与索引的序号对不上 -> 高亮跑到别的地方去了(用户实测: 搜 623532
 * 却标出 `q5 s5 q,5. ...`)。口径只能有一份: 用 jptok.parseToken。
 */
function renderScore(raw, at, qlen, bars) {
  if (!raw) return '';
  var toks = raw.split(' ');
  var barSet = {};
  (bars || []).forEach(function (b) { barSet[b] = 1; });
  var noteIdx = -1, html = [], endTok = -1, startTok = -1;
  for (var i = 0; i < toks.length; i++) {
    if (parseToken(toks[i])) {
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
    var isNote = !!parseToken(toks[j]);
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
      '<div class="links">' + externalLinks(r) +
        '<a class="add" href="' + issueUrl(r.group) + '" target="_blank" rel="noopener" ' +
        'title="库里这首有问题 / 想补充资料 → 一键提 issue">＋ 反馈/补充</a>' +
      '</div></div>';
  }
  $('out').innerHTML = html +
    '<p class="hint">代价 0 = 连升降号都一致；你没写记号时对上带 #/b 的音记 1，' +
    '写了记号而库里是自然音记 2。“记号”是升降号完全一致的音数。' +
    '点上方各站名可直接跳去核对这首歌是什么（MusicBrainz / 网易云 / QQ音乐 / B站 / YouTube）。</p>';
}

$('form').addEventListener('submit', run);
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
