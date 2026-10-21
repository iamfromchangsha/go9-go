/* 失误普查：让引擎自对弈，把它每一手按「常见失误类型」分类统计
 * 运行： node test/diag-mistakes.mjs [局数]
 *
 * 要回答的问题：引擎在实战里到底在下什么臭棋？
 *   1. 自杀手：落子后自己那块只剩一口气，且没吃到子
 *   2. 漏吃子：对手有一块棋只剩一口气（可以提），引擎却下在别处
 *   3. 填自己眼：下在自己被围住的空区里（大小眼都算）
 *   4. 下在对手势力范围里（贴着对手的厚势挨着下）
 *   5. 一线/二线手占比
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
const { idx, xOf, yOf, BLACK, WHITE, EMPTY, Board } = E;
const lineOf = p => Math.min(xOf(p), 8 - xOf(p), yOf(p), 8 - yOf(p));
const COARSE = 60, FINE = 220, REFINE = 14;
const GAMES = parseInt(process.argv[2] || '2', 10);

/* 判断落子是否自 suicide：落子后己方那块只剩一口气且没提子 */
function isSelfAtari(boardBefore, p, color) {
  const b = boardBefore.clone();
  const opp = 3 - color;
  const capBefore = b.caps[color];
  if (!b.play(p, color)) return false;
  if (b.caps[color] > capBefore) return false;       // 吃到子了，不算自杀
  const g = E.groupStats(b, p);
  return g.libs <= 1;
}

/* 落子后把己方的棋子全部移除，检查这一手是否在己方真眼里 */
function inOwnEye(boardBefore, p, color) {
  const b = boardBefore.clone();
  if (!b.play(p, color)) return false;
  b.stones[p] = EMPTY; b.toggle(p, color);
  // 这一手周围如果全是自己的子，且这块空区被自己围住 → 真眼
  const ana = E.analyzeBoard(b);
  // 找 p 所在的空区
  const seen = new Uint8Array(121);
  const stack = [p]; seen[p] = 1;
  let size = 0, hasB = false, hasW = false;
  while (stack.length) {
    const c = stack.pop(); size++;
    for (const n of E.NEI[c]) {
      if (b.stones[n] === EMPTY && !seen[n]) { seen[n] = 1; stack.push(n); }
      else if (b.stones[n] === BLACK) hasB = true;
      else if (b.stones[n] === WHITE) hasW = true;
    }
  }
  return size >= 2 && hasB && !hasW;
}

/* 对手有没有可以提的块（返回可提的点与块的大小） */
function captureOpportunity(board, color) {
  const opp = 3 - color;
  const ana = E.analyzeBoard(board);
  for (let p = 0; p < 121; p++) {
    if (board.stones[p] !== opp) continue;
    if (ana.libs[p] !== 1) continue;
    const g = E.groupStats(board, p);
    if (g.ata >= 0 && g.ata !== board.ko) return { at: g.ata, size: g.size };
  }
  return null;
}

console.log(`=== 失误普查（${GAMES} 局自对弈，l4）===\n`);
const tally = { selfAtari: 0, missedCap: 0, missedCap2: 0, ownEye: 0, total: 0, edge1: 0, edge2: 0 };
const phase = {};
const phaseName = m => m < 12 ? '开局(1-11)' : m < 30 ? '早中盘(12-29)' : m < 50 ? '中盘(30-49)' : '官子(50+)';
const P = n => (phase[n] = phase[n] || { n: 0, l1: 0, l2: 0, sa: 0, mc: 0, oe: 0 });
const examples = [];

for (let g = 0; g < GAMES; g++) {
  const rng = ai.makeRng(20261021 + g * 7919);
  const b = new Board();
  const level = ai.LEVELS.find(l => l.key === 'l4');
  for (let m = 0; m < 70; m++) {
    const color = b.toPlay;
    const cands = E.candidateMoves(b, color, E.analyzeBoard(b));
    if (!cands.length) break;
    const stats = ai.evalMovesSync(b, 6.5, cands, COARSE, FINE, 3000 + g * 977 + m * 31, REFINE, color === BLACK);
    const mv = ai.chooseAiMove(stats, level, rng, cands);
    if (mv < 0) break;

    tally.total++;
    const d = lineOf(mv);
    if (d === 0) tally.edge1++;
    if (d === 1) tally.edge2++;
    const ph = phaseName(m);
    const pp = P(ph);
    pp.n++;
    if (d === 0) pp.l1++;
    if (d === 1) pp.l2++;

    const selfAtari = isSelfAtari(b, mv, color);
    const ownEye = inOwnEye(b, mv, color);
    const cap = captureOpportunity(b, color);
    const missed = cap && cap.at !== mv;
    const missedBig = missed && cap.size >= 2;

    if (selfAtari) { tally.selfAtari++; pp.sa++; }
    if (missed) { tally.missedCap++; pp.mc++; }
    if (missedBig) tally.missedCap2++;
    if (ownEye) { tally.ownEye++; pp.oe++; }
    if ((selfAtari || ownEye || missedBig) && examples.length < 30) {
      examples.push(`  第${g + 1}局第${m + 1}手 ${color === BLACK ? '黑' : '白'} 下 (${xOf(mv)},${yOf(mv)})线${d}` +
        `${selfAtari ? ' 【自杀手】' : ''}${ownEye ? ' 【填自己眼】' : ''}` +
        `${missedBig ? ` 【漏提${cap.size}子：可提(${xOf(cap.at)},${yOf(cap.at)})】` : ''}`);
    }

    b.play(mv, color);
    b.toPlay = 3 - color;
  }
}

console.log('失误类型统计：');
console.log(`  总手数 ${tally.total}`);
console.log(`  自杀手（自己那块只剩一口气且没吃到子）: ${tally.selfAtari}  (${(tally.selfAtari / tally.total * 100).toFixed(1)}%)`);
console.log(`  漏吃子（对手有块只剩一口气可以提）:     ${tally.missedCap}  (${(tally.missedCap / tally.total * 100).toFixed(1)}%)`);
console.log(`  其中漏提「≥2 子」的块:                  ${tally.missedCap2}  (${(tally.missedCap2 / tally.total * 100).toFixed(1)}%)`);
console.log(`  填自己的眼（下手在自己围住的空区里）:   ${tally.ownEye}  (${(tally.ownEye / tally.total * 100).toFixed(1)}%)`);
console.log(`  一线手 ${tally.edge1}  二线手 ${tally.edge2}  (一二线合计 ${((tally.edge1 + tally.edge2) / tally.total * 100).toFixed(1)}%)`);

console.log('\n分阶段：');
console.log('  阶段            手数   一线  二线   一二线%   自杀%   漏吃%   填眼%');
for (const k of Object.keys(phase)) {
  const p = phase[k];
  console.log(`  ${k.padEnd(14)} ${String(p.n).padStart(4)} ${String(p.l1).padStart(5)} ${String(p.l2).padStart(5)}` +
    ` ${((p.l1 + p.l2) / p.n * 100).toFixed(0).padStart(8)} ${(p.sa / p.n * 100).toFixed(0).padStart(8)}` +
    ` ${(p.mc / p.n * 100).toFixed(0).padStart(8)} ${(p.oe / p.n * 100).toFixed(0).padStart(8)}`);
}
console.log('\n实例：');
for (const e of examples) console.log(e);
