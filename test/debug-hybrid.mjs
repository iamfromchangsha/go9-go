/* 标定混合权重 λ：静态势力项 vs 蒙特卡洛项
 * 指标：①着法差距估计的噪声 ②决定性提子能否排第一 ③AI 实际下的线位分布
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
const { idx, Board, BLACK, WHITE } = E;
const COLS = 'ABCDEFGHJ';
const lineOf = (x, y) => Math.min(x, y, 8 - x, 8 - y) + 1;

/* ---------- ① 差距噪声 ---------- */
function gapNoise(weight) {
  ai.setMcWeight(weight);
  const b = new Board();
  b.stones[idx(2, 4)] = WHITE; b.toggle(idx(2, 4), WHITE);
  b.toPlay = BLACK;
  const ana = E.analyzeBoard(b);
  const legal = E.candidateMoves(b, BLACK, ana);
  const A = idx(2, 2), B = idx(4, 3);
  const gaps = [];
  for (let g = 0; g < 10; g++) {
    const seed = (g * 7919 + 11) >>> 0;
    const sa = ai.evalMovesSync(b, 6.5, [A], 60, 220, seed, 1).get(A);
    const sb = ai.evalMovesSync(b, 6.5, [B], 60, 220, seed, 1).get(B);
    gaps.push(sa.margin - sb.margin);
  }
  const m = gaps.reduce((x, y) => x + y, 0) / gaps.length;
  const sd = Math.sqrt(gaps.reduce((x, y) => x + (y - m) ** 2, 0) / gaps.length);
  return sd;
}

/* ---------- ② 决定性提子能否排第一 ---------- */
function captureRank(weight) {
  ai.setMcWeight(weight);
  const b = new Board();
  for (const [x, y] of [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1]]) { b.stones[idx(x, y)] = WHITE; b.toggle(idx(x, y), WHITE); }
  for (const [x, y] of [[3, 0], [3, 1], [2, 1], [0, 2]]) { b.stones[idx(x, y)] = BLACK; b.toggle(idx(x, y), BLACK); }
  b.toPlay = BLACK;
  const ana = E.analyzeBoard(b);
  const legal = E.candidateMoves(b, BLACK, ana);
  const stats = ai.evalMovesSync(b, 6.5, legal, 60, 220, 20260921, 14);
  const ranked = [...stats.entries()].sort((x, y) => y[1].wr - x[1].wr);
  return { rank: ranked.findIndex(([mv]) => mv === idx(1, 2)) + 1, wr: stats.get(idx(1, 2)).wr };
}

/* ---------- ③ AI 实际线位分布（自对弈 30 手） ---------- */
function lineProfile(weight, seed) {
  ai.setMcWeight(weight);
  const b = new Board();
  b.hist = new Map(); b.trackSuperko = true; b.hist.set(b.hash(), true);
  const rng = ai.makeRng(seed);
  const level = ai.LEVELS[2];
  const cnt = {};
  for (let i = 0; i < 30; i++) {
    const ana = E.analyzeBoard(b);
    const legal = E.candidateMoves(b, b.toPlay, ana);
    if (!legal.length) break;
    const stats = ai.evalMovesSync(b, 6.5, legal, 60, 220, (i * 7919 + 13 + seed) >>> 0, 14);
    const mv = ai.chooseAiMove(stats, level, rng, legal);
    if (mv < 0) break;
    b.play(mv, b.toPlay); b.toPlay = 3 - b.toPlay;
    const l = lineOf(E.xOf(mv), E.yOf(mv));
    cnt[l] = (cnt[l] || 0) + 1;
  }
  const low = (cnt[1] || 0) + (cnt[2] || 0);
  const total = Object.values(cnt).reduce((a, c) => a + c, 0);
  return { low, total, pct: (low / total * 100).toFixed(0), cnt };
}

console.log('λ(模拟权重)  差距噪声(目)  提子排名  自对弈一二线占比');
for (const w of [0, 0.25, 0.45, 0.7, 1.0]) {
  const noise = gapNoise(w);
  const cap = captureRank(w);
  const prof = lineProfile(w, 4242);
  console.log(`   ${w.toFixed(2)}        ${noise.toFixed(2)}         第${cap.rank}位      ${prof.pct}% (${prof.cnt && Object.keys(prof.cnt).map(k => k + '线:' + prof.cnt[k]).join(' ')})`);
}
