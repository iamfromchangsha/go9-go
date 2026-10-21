/* 决策损失：候选引擎在固定局面集上，比「高样本参照值」差多少
 * 运行： node test/exp-decision-loss.mjs [--ref HEAD] [--games 6] [--truth 1200]
 *
 * 做法：
 *   1) 用参照引擎自对弈生成一批局面（开局/中盘/官子各若干）
 *   2) 对每个局面的每个候选着法，用**参照引擎的高样本纯 MC**算出「真值」V*(m)
 *      （真值只算一次，所有被测引擎共用同一把尺子）
 *   3) 让每个引擎按自己的正常预算选一手
 *   4) 损失 = V*(最优) − V*(它选的那手)，单位是「终局目数」
 *   损失越小 = 选点越接近最优，且是配对比较，方差小。
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const REF = argOf('--ref', 'HEAD');
const GAMES = parseInt(argOf('--games', '4'), 10);
const TRUTH = parseInt(argOf('--truth', '1200'), 10);
const COARSE = parseInt(argOf('--coarse', '60'), 10);
const FINE = parseInt(argOf('--fine', '220'), 10);
const REFINE = parseInt(argOf('--refine', '14'), 10);
const KOMI = 6.5;

function loadSources(aiSrc, engineSrc) {
  const ctx = { console, Math, Date, JSON, Map, Set, Array, Object, Number, String, Boolean, Error, isFinite, parseInt, parseFloat };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(engineSrc, ctx);
  vm.runInContext(aiSrc, ctx);
  return ctx.GO9;
}
function gitShow(rel) {
  return execFileSync('git', ['show', `${REF}:${rel}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 24 });
}
function rebuild(GO9, moves) {
  const { engine: E } = GO9;
  const { BLACK, WHITE, Board } = E;
  const b = new Board();
  for (const mv of moves) {
    const c = mv.color === 'B' ? BLACK : WHITE;
    if (mv.p < 0) { b.passTurn(); b.toPlay = 3 - c; continue; }
    b.play(mv.p, c);
    b.toPlay = 3 - c;
  }
  return b;
}

const refGO9 = loadSources(gitShow('js/ai.js'), gitShow('js/engine.js'));
const candGO9 = loadSources(
  fs.readFileSync(path.join(ROOT, 'js/ai.js'), 'utf8'),
  fs.readFileSync(path.join(ROOT, 'js/engine.js'), 'utf8'));

/* ---------- 1) 生成局面 ---------- */
const positions = [];
{
  const { engine: E, ai } = refGO9;
  for (let g = 0; g < GAMES; g++) {
    const rng = ai.makeRng(555 + g * 131);
    const b = new E.Board();
    const moves = [];
    const level = ai.LEVELS.find(l => l.key === 'l4');
    for (let m = 0; m < 60; m++) {
      const color = b.toPlay;
      const cands = E.candidateMoves(b, color, E.analyzeBoard(b));
      if (!cands.length) break;
      const st = ai.evalMovesSync(b, KOMI, cands, COARSE, FINE, 700 + g * 77 + m * 13, REFINE, color === E.BLACK);
      const mv = ai.chooseAiMove(st, level, rng, cands);
      if (mv < 0) break;
      moves.push({ color: color === E.BLACK ? 'B' : 'W', p: mv });
      b.play(mv, color); b.toPlay = 3 - color;
      // 每局取 5 个采样局面：开局/中盘/官子
      if (m === 4 || m === 14 || m === 26 || m === 40 || m === 56) {
        positions.push({ moves: moves.slice(), label: `第${g + 1}局第${m + 1}手` });
      }
    }
  }
}
console.log(`局面集：${positions.length} 个（${GAMES} 局自对弈采样）`);

/* ---------- 2) 算真值（参照引擎的高样本纯 MC） ---------- */
console.log(`计算真值中（每候选 ${TRUTH} 次模拟）…`);
const truths = [];
for (const pos of positions) {
  const { engine: E, ai } = refGO9;
  const b = rebuild(refGO9, pos.moves);
  const color = b.toPlay;
  const cands = E.candidateMoves(b, color, E.analyzeBoard(b));
  if (!cands.length) continue;
  const st = ai.evalMovesSync(b, KOMI, cands, TRUTH, TRUTH, 424242, cands.length, color === E.BLACK);
  const v = new Map();
  let best = -Infinity;
  for (const [mv, info] of st) { v.set(mv, info.mcMargin); if (info.mcMargin > best) best = info.mcMargin; }
  truths.push({ pos, v, best, color });
}

/* ---------- 3) 让两个引擎选点，算损失 ---------- */
function lossOf(GO9, t) {
  const { engine: E, ai } = GO9;
  const b = rebuild(GO9, t.pos.moves);
  const cands = E.candidateMoves(b, t.color, E.analyzeBoard(b));
  if (!cands.length) return { loss: NaN, pick: -1 };
  const level = ai.LEVELS.find(l => l.key === 'l4');
  const st = ai.evalMovesSync(b, KOMI, cands, COARSE, FINE, 424242, REFINE, t.color === E.BLACK);
  const rng = ai.makeRng(777);
  const pick = ai.chooseAiMove(st, level, rng, cands);
  const pv = t.v.has(pick) ? t.v.get(pick) : t.best;
  return { loss: t.best - pv, pick };
}

let refLoss = 0, candLoss = 0, n = 0, refTop = 0, candTop = 0;
const rows = [];
for (const t of truths) {
  const r = lossOf(refGO9, t);
  const c = lossOf(candGO9, t);
  if (!isFinite(r.loss) || !isFinite(c.loss)) continue;
  refLoss += r.loss; candLoss += c.loss; n++;
  if (r.loss < 0.05) refTop++;
  if (c.loss < 0.05) candTop++;
  rows.push(`  ${t.pos.label.padEnd(12)} 参照损失 ${r.loss.toFixed(2).padStart(6)}   候选损失 ${c.loss.toFixed(2).padStart(6)}`);
}
console.log('\n逐局面：');
for (const r of rows) console.log(r);
console.log(`\n参照（${REF}）平均决策损失：${(refLoss / n).toFixed(3)} 目   命中最优 ${refTop}/${n}`);
console.log(`候选（工作区）平均决策损失：${(candLoss / n).toFixed(3)} 目   命中最优 ${candTop}/${n}`);
const delta = (candLoss - refLoss) / n;
console.log(delta < -0.01 ? `\n结论：候选更强 ✓（平均少亏 ${(-delta).toFixed(3)} 目）`
  : delta > 0.01 ? `\n结论：候选更弱 ✗（平均多亏 ${delta.toFixed(3)} 目）`
    : '\n结论：与参照无显著差异');
