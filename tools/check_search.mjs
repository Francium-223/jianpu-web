// node tools/check_search.mjs —— 前端检索 headless 校验(与 Python 侧 lookup_acc.py 同口径)
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { buildIndex, search } from '../static/search.js';
import { parseQuery, show } from '../static/jptok.js';

const gz = readFileSync(new URL('../data/songs.jsonl.gz', import.meta.url));
const t0 = Date.now();
const idx = buildIndex(gunzipSync(gz).toString('utf8'));
console.log(`索引 ${idx.count} 首 / ${idx.groupCount} 组，${Date.now() - t0} ms\n`);

// [查询, 期望曲名, 说明] —— 期望值以 Python 侧为基准
const CASES = [
  // 2026-09-25 起按用户选的"段落权重参与排序"(B): 8 音的 63731232 在两首里都 0 代价,
  // 但《U.N.オーエンは彼女なのか？》那处落在**副歌**(1.6)、《神々が恋した幻想郷》那处落在
  // **发狂钢琴**(0.8) -> 前者排前。老期望写的是"唯一命中"(那时没有段落权重)。
  ['63731232', 'U.N.オーエンは彼女なのか？', '8 音 0 代价（副歌 vs 发狂钢琴，段落加权后）'],
  ['55532235 3211612655', '上春山', '两段'],
  ['5 5 5 3 2 2 3 5 3 2 1 1 6 1 2 6 5 5', '上春山', '空格不分段'],
  ['66165535 532322 7656', '鲁冰花', '三段'],
  ['5111156711', '义勇军进行曲', '单段'],
];
let pass = 0;
for (const [q, want, note] of CASES) {
  const segs = q.split(/[;；|、+，,]+/).map(parseQuery).filter((s) => s.length >= 5);
  const t = Date.now();
  const res = search(idx, segs, { top: 3 });
  const top = res[0];
  const ok = top && (top.group === want || top.title === want);
  if (ok) pass++;
  console.log(`${ok ? '✓' : '✗'} ${q.padEnd(38)} -> ${top ? `${top.group} (代价 ${top.cost})` : '无'}  ${Date.now() - t} ms  [${note}]`);
  if (top) console.log(`     库内该段 ${show(top.libNotes)}  |  输入 ${show(top.qNotes)}`);
  if (!ok) console.log('     候选:', res.map((r) => `${r.group}(${r.cost})`).join(' | '));
}
console.log(`\n通过 ${pass}/${CASES.length}`);
