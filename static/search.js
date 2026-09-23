/* 旋律检索(浏览器端, 零依赖) —— 口径与 Python 侧 lookup_acc.py 一致
 *
 * 代价模型(用户口径: 发送从严, 接收从宽):
 *   query\lib   自然   #    b
 *   自然         0    1    1     <- 用户没写记号: 宽容(但不如精确命中)
 *   #            2    0    3     <- 用户写了记号: 必须对上才 0
 *   b            2    3    0
 * 音级不同: 4(最重)。
 * 排序: 总代价 -> 精确记号命中数 -> 热度 -> 非改编 -> 名短 -> 组名
 */

const BAD = /吉他|钢琴|双谱|器乐|非洲|尤克里里|古筝|琵琶|二胡|笛|萨克斯|总谱|合唱/;
const TAIL = /(?:[-_（(]?\s*(?:简谱|歌曲类|歌谱|五线谱|正谱|完整版|弹唱|吉他谱|钢琴谱)\s*[)）]?)+$/;

function popKey(g) {
  let k = g;
  for (let i = 0; i < 3; i++) { const k2 = k.replace(TAIL, ''); if (k2 === k || !k2) break; k = k2; }
  return k;
}

/** 解析一段文本(每行一首 JSON) -> 索引 */
export function buildIndex(text) {
  const songs = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (!r.p) continue;
    songs.push({
      title: r.t, group: r.g, source: r.s, status: r.st, n: r.n,
      p: r.p, a: r.a || '', o: r.o || '', raw: r.raw || '', trunc: !!r.trunc,
    });
  }
  const groups = new Map();
  for (const s of songs) {
    if (!groups.has(s.group)) groups.set(s.group, []);
    groups.get(s.group).push(s);
  }
  const pop = new Map();
  for (const [g, v] of groups) {
    const k = popKey(g);
    pop.set(k, (pop.get(k) || 0) + v.length);
  }
  return { songs, groups, pop, count: songs.length, groupCount: groups.size };
}

/** 每首歌把 p/a/o 三级数组缓存到对象上(第一次访问时构建) */
function arraysOf(s) {
  if (s._p) return s._p;
  const n = s.p.length;
  const P = new Uint8Array(n), A = new Int8Array(n), O = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    P[i] = s.p.charCodeAt(i) - 48;
    A[i] = s.a.charCodeAt(i) === 49 ? 1 : s.a.charCodeAt(i) === 50 ? -1 : 0;
    O[i] = 0;
  }
  if (s.o) {
    const parts = s.o.split(',');
    for (let i = 0; i < n && i < parts.length; i++) O[i] = parseInt(parts[i], 10) || 0;
  }
  s._p = { P, A, O };
  return s._p;
}

function cost(q, cd, ca) {
  if (q.d !== cd) return 4;
  if (q.acc === ca) return 0;
  if (q.acc === 0) return 1;
  if (ca === 0) return 2;
  return 3;
}

/**
 * 检索。
 * @param idx  buildIndex 的结果
 * @param segs parseQuery 得到的音符数组(每段 >=5 音)——**支持多段**: 各段取最小代价后相加
 * @param opt  {top, c1, c2, c3}
 */
export function search(idx, segs, opt) {
  opt = opt || {};
  const top = opt.top || 10;
  const res = [];
  for (const [group, members] of idx.groups) {
    let total = 0, exact = 0, det = [], ok = true;
    for (const q of segs) {
      const n = q.length;
      let best = null;
      for (const s of members) {
        const { P, A } = arraysOf(s);
        if (P.length < n) continue;
        for (let i = 0; i + n <= P.length; i++) {
          let c = 0;
          for (let k = 0; k < n; k++) {
            c += cost(q[k], P[i + k], A[i + k]);
            if (best && c >= best.cost) break;
          }
          if (!best || c < best.cost) best = { cost: c, at: i, song: s, q: q };
        }
      }
      if (!best) { ok = false; break; }
      total += best.cost;
      for (let k = 0; k < n; k++) {
        const { A } = arraysOf(best.song);
        if (best.q[k].acc === A[best.at + k]) exact++;
      }
      det.push(best);
    }
    if (ok && det.length) res.push({ group, total, exact, det });
  }
  res.sort((x, y) =>
    x.total - y.total ||
    y.exact - x.exact ||
    (idx.pop.get(popKey(y.group)) || 0) - (idx.pop.get(popKey(x.group)) || 0) ||
    (BAD.test(x.group) ? 1 : 0) - (BAD.test(y.group) ? 1 : 0) ||
    x.group.length - y.group.length ||
    (x.group < y.group ? -1 : 1));
  return res.slice(0, top).map((r) => {
    const h = r.det[0];
    const n = h.q.length;
    const arr = arraysOf(h.song);
    return {
      title: h.song.title, group: r.group, source: h.song.source, status: h.song.status,
      n: h.song.n, cost: r.total, exact: r.exact, qlen: n, at: h.at,
      raw: h.song.raw, trunc: h.song.trunc,
      libNotes: Array.from({ length: n }, (_, k) => ({ d: arr.P[h.at + k], acc: arr.A[h.at + k] })),
      qNotes: h.q,
    };
  });
}

export { popKey };
