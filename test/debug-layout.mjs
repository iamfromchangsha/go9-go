/* 诊断：引擎的布局偏好到底偏向哪里
 * 1) 空盘候选着法的位置分布（角/边/中腹）
 * 2) 模拟终局里，中腹空隙有多少被判成"无主"
 * 3) 与"人类常识布局"对比：引擎是否愿意下中央/挂角
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'js/engine.js'), 'utf8'));
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'js/ai.js'), 'utf8'));
const { engine: E, ai } = globalThis.GO9;
const { idx, Board, BLACK, WHITE, EMPTY, xOf, yOf } = E;

function zone(x, y) {
  const d = Math.min(x, y, 8 - x, 8 - y);   // 0 = 一线, 1 = 二线, 2 = 三线, 3 = 四线(中腹)
  if (d <= 1) return '角/一二线';
  if (d === 2) return '三线';
  return '中腹(四线+)';
}

/* ---------- 1. 空盘候选分布 ---------- */
{
  const b = new Board();
  b.toPlay = BLACK;
  const ana = E.analyzeBoard(b);
  const legal = E.candidateMoves(b, BLACK, ana);
  const stats = ai.evalMovesSync(b, 6.5, legal, 60, 220, 12345, 20);
  const ranked = [...stats.entries()].sort((a, c) => c[1].wr - a[1].wr);
  console.log('=== 空盘：引擎候选前 12 ===');
  const zones = {};
  ranked.forEach(([mv, inf], i) => {
    const z = zone(xOf(mv), yOf(mv));
    zones[z] = (zones[z] || 0) + 1;
    if (i < 12) console.log(`  ${String(i + 1).padStart(2)}. ${String.fromCharCode(65 + xOf(mv))}${9 - yOf(mv)}  wr=${(inf.wr * 100).toFixed(1)}%  [${z}]`);
  });
  const top = ranked.slice(0, 12).map(([mv]) => zone(xOf(mv), yOf(mv)));
  const cnt = {};
  top.forEach(z => cnt[z] = (cnt[z] || 0) + 1);
  console.log('  前 12 名分区:', JSON.stringify(cnt));
}

/* ---------- 2. 模拟终局：中腹空隙归属 ---------- */
{
  const rng = ai.makeRng(4242);
  const b = new Board();
  // 摆一个典型布局：黑占双星，白占角
  for (const [x, y] of [[2, 2], [6, 6]]) { b.stones[idx(x, y)] = BLACK; b.toggle(idx(x, y), BLACK); }
  for (const [x, y] of [[6, 2]]) { b.stones[idx(x, y)] = WHITE; b.toggle(idx(x, y), WHITE); }
  b.toPlay = BLACK;

  let neutral = 0, blackOwn = 0, whiteOwn = 0, total = 0;
  for (let i = 0; i < 200; i++) {
    const t = b.clone();
    const sc = ai.simulate(t, rng, ai.SIM_OPTS);
    for (let p = 0; p < 121; p++) {
      if (E.xOf(p) < 0 || E.yOf(p) < 0 || E.xOf(p) > 8 || E.yOf(p) > 8) continue;
      total++;
      const o = sc.owner[p];
      if (o === BLACK) blackOwn++;
      else if (o === WHITE) whiteOwn++;
      else neutral++;
    }
  }
  console.log('\n=== 模拟终局归属（200 次平均）===');
  console.log(`  黑 ${(blackOwn / total * 100).toFixed(1)}%  白 ${(whiteOwn / total * 100).toFixed(1)}%  无主 ${(neutral / total * 100).toFixed(1)}%`);

  // 分区看无主比例
  const zoneStat = {};
  for (let i = 0; i < 200; i++) {
    const t = b.clone();
    const sc = ai.simulate(t, rng, ai.SIM_OPTS);
    for (let p = 0; p < 121; p++) {
      const x = E.xOf(p), y = E.yOf(p);
      if (x < 0 || y < 0 || x > 8 || y > 8) continue;
      const z = zone(x, y);
      zoneStat[z] = zoneStat[z] || { n: 0, neutral: 0, black: 0, white: 0 };
      zoneStat[z].n++;
      const o = sc.owner[p];
      if (o === BLACK) zoneStat[z].black++;
      else if (o === WHITE) zoneStat[z].white++;
      else zoneStat[z].neutral++;
    }
  }
  console.log('  分区无主比例:');
  for (const [z, s] of Object.entries(zoneStat)) {
    console.log(`    ${z.padEnd(12)} 无主 ${(s.neutral / s.n * 100).toFixed(1)}%  黑 ${(s.black / s.n * 100).toFixed(1)}%  白 ${(s.white / s.n * 100).toFixed(1)}%`);
  }
}

/* ---------- 3. 中腹着法的价值 vs 角上着法 ---------- */
{
  const b = new Board();
  b.toPlay = BLACK;
  const ana = E.analyzeBoard(b);
  const legal = E.candidateMoves(b, BLACK, ana);
  const stats = ai.evalMovesSync(b, 6.5, legal, 60, 220, 12345, 20);
  const byZone = {};
  for (const [mv, inf] of stats) {
    const z = zone(xOf(mv), yOf(mv));
    (byZone[z] = byZone[z] || []).push(inf.wr);
  }
  console.log('\n=== 各区着法的平均胜率（模拟给出）===');
  for (const [z, arr] of Object.entries(byZone)) {
    const avg = arr.reduce((a, c) => a + c, 0) / arr.length;
    const max = Math.max(...arr);
    console.log(`  ${z.padEnd(12)} 点数 ${String(arr.length).padStart(2)}  平均 ${(avg * 100).toFixed(1)}%  最高 ${(max * 100).toFixed(1)}%`);
  }
}
