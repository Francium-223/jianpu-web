/* 简谱 token 解析 —— 唯一实现(与 Python 侧 skills/jianpu-melody-lookup/jptok.py 同口径)
 *
 * token 形态:  [时值 qsdh]* [,']* [#b♯♭]? [1-7x0] [,']* [.]*
 * 变音: # ♯ = +1, b ♭ = -1, 无 = 0        八度: , = -1, ' = +1
 * 休止 0 / 念白 x: 不算音高(但仍是 token)
 *
 * 为什么要单独一个文件: 同一套白名单以前散在多处, 升降号口径各不相同 ——
 * 实测导致全库带 # 的音在索引里被整段丢掉, 检索永远匹配不上。口径只能有一份。
 */
const TOKEN = /^([qsdh]*)([,']*)([#b♯♭]?)([1-7x0])([,']*)[.]*$/;
const LOOSE = /^([qsdh]*)([,']*)([#b♯♭]?)([1-7x0])([,']*)([#b♯♭]?)[.]*$/;

/** token -> {d: 音级 1-7 或 0/x, acc: -1/0/1, oct: 整数} 或 null */
export function parseToken(t) {
  const m = TOKEN.exec(t) || LOOSE.exec(t);
  if (!m) return null;
  const pre = m[1], octs = m[2], acc = m[3], dig = m[4], post = m[5];
  const acc2 = m[6] || '';
  const a = (acc === '#' || acc === '♯' || acc2 === '#' || acc2 === '♯') ? 1
          : (acc === 'b' || acc === '♭' || acc2 === 'b' || acc2 === '♭') ? -1 : 0;
  const off = (octs + post).split(',').length - 1 - ((octs + post).split("'").length - 1);
  return { d: dig, acc: a, oct: off };
}

/** 整段用户输入 -> [{d,acc,oct}]，只保留 1-7 */
export function parseQuery(raw) {
  const out = [];
  const re = /([#b♯♭]?)([,']*)([1-7])([,']*)([#b♯♭]?)/g;
  let m;
  while ((m = re.exec(String(raw)))) {
    const a = (m[1] === '#' || m[1] === '♯' || m[5] === '#' || m[5] === '♯') ? 1
            : (m[1] === 'b' || m[1] === '♭' || m[5] === 'b' || m[5] === '♭') ? -1 : 0;
    const s = m[2] + m[4];
    const off = s.split(',').length - 1 - (s.split("'").length - 1);
    out.push({ d: +m[3], acc: a, oct: off });
  }
  return out;
}

/** [{d,acc,oct}] -> 可读串，如 `6 3 7 #5` */
export function show(notes) {
  return notes.map((n) => (n.acc === 1 ? '#' : n.acc === -1 ? 'b' : '') + n.d).join(' ');
}
