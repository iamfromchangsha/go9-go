/* 逐决策配对比较：候选引擎的每一手，比参照引擎的同一手差多少
 * 运行： node test/exp-decision-paired.mjs [--ref HEAD] [--positions 40] [--plays 24]
 *
 * 为什么要有这个指标：
 *   整局胜率（对擂）一局要 100+ 秒、8 局也只有 ±20% 的噪声；
 *   而「在同一个局面下，两个引擎选的那一手，最终目差差多少」是配对比较，
 *   噪声小一个量级 —— 这才是评估「引擎选点质量」该用的尺子。
 *
 * 做法：
 *   1. 用参照引擎自对弈生成一批局面
 *   2. 每个局面让两个引擎各选一手（各自用自己的正常预算）
 *   3. 选得不一样时，用**同一个中立裁判**（参照引擎的模拟）从两个后续局面各跑 K 局，
 *      比终局目差（行棋方视角）
 *   4. 差值求和：正数=候选更差，负数=候选更好
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
const N_POS = parseInt(argOf('--positions', '40'), 10);
const K = parseInt(argOf('--plays', '24'), 10);
const KOMI = 6.5;
const COARSE = 60, FINE = 220, REFINE = 14;

function loadSources(aiSrc, engineSrc, extraSrc) {
  const ctx = { console, Math, Date, JSON, Map, Set, Array, Object, Number, String, Boolean, Error, isFinite, parseInt, parseFloat };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(engineSrc, ctx);
  vm.runInContext(aiSrc, ctx);
  if (extraSrc) vm.runInContext(extraSrc, ctx);
  return ctx.GO9;
}
function gitShow(rel) {
  return execFileSync('git', ['show', `${REF}:${rel}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 24 });
}
const PW = path.join(ROOT, 'js/pattern-weights.js');
const refGO9 = loadSources(gitShow('js/ai.js'), gitShow('js/engine.js'));
const candGO9 = loadSources(
  fs.readFileSync(path.join(ROOT, 'js/ai.js'), 'utf8'),
  fs.readFileSync(path.join(ROOT, 'js/engine.js'), 'utf8'),
  fs.existsSync(PW) ? fs.readFileSync(PW, 'utf8') : null);

// 3×3 策略开关（验收闸门用）：
//   --candidate-pattern on|off   候选引擎是否开策略（默认 off，与 v1.0.6 发布态一致）
//   --ref-pattern on|off        参照引擎是否开策略（默认 off）
//   --ref-weights <文件>        参照引擎加载的权重表（默认不加载 = 手工权重）
//   --referee ref|cand          裁判用哪一方的模拟（默认 ref = 冻结的参照版）
const CAND_PATTERN = argOf('--candidate-pattern', 'off') === 'on';
const REF_PATTERN = argOf('--ref-pattern', 'off') === 'on';
const REFW = argOf('--ref-weights', '');
const REFEREE = argOf('--referee', 'ref');
{
  const refSrc = REFW && fs.existsSync(path.resolve(ROOT, REFW)) ? fs.readFileSync(path.resolve(ROOT, REFW), 'utf8') : null;
  if (refSrc) {
    // 参照引擎换成「git HEAD 的代码 + 指定权重表」
    const r = loadSources(gitShow('js/ai.js'), gitShow('js/engine.js'), refSrc);
    refGO9.engine = r.engine; refGO9.ai = r.ai;
  }
  refGO9.ai.SIM_OPTS.pattern = REF_PATTERN;
  candGO9.ai.SIM_OPTS.pattern = CAND_PATTERN;
  console.log(`策略开关：候选=${CAND_PATTERN ? '开' : '关'}  参照=${REF_PATTERN ? '开' : '关'}` +
    `${REFW ? `  参照权重表=${REFW}` : ''}  裁判=${REFEREE === 'ref' ? '参照版(冻结)' : '候选版'}`);
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

/** 某个引擎在给定局面选一手 */
function pick(GO9, moves, color, seed) {
  const { engine: E, ai } = GO9;
  const b = rebuild(GO9, moves);
  const cands = E.candidateMoves(b, color, E.analyzeBoard(b));
  if (!cands.length) return -1;
  const stats = ai.evalMovesSync(b, KOMI, cands, COARSE, FINE, seed, REFINE, color === E.BLACK);
  const rng = ai.makeRng(seed ^ 0x9e3779b9);
  return ai.chooseAiMove(stats, ai.LEVELS[4], rng, cands);
}

/** 中立裁判：从「落子后」的局面跑 K 局，返回终局目差（行棋方视角） */
function referee(GO9, moves, mv, color, seed) {
  const { engine: E, ai } = GO9;
  const b = rebuild(GO9, moves);
  const child = b.clone();
  if (!child.play(mv, color)) return null;
  child.toPlay = 3 - color;
  const rng = ai.makeRng(seed);
  let sum = 0;
  for (let i = 0; i < K; i++) {
    const sc = ai.simulate(child.clone(), rng, ai.SIM_OPTS);
    sum += (color === E.BLACK ? sc.black - sc.white : sc.white - sc.black);
  }
  return sum / K;
}

/* ---------- 1) 生成局面 ---------- */
console.log(`生成 ${N_POS} 个局面…`);
const positions = [];
{
  const { engine: E, ai } = refGO9;
  const rng = ai.makeRng(20261023);
  while (positions.length < N_POS) {
    const b = new E.Board();
    const moves = [];
    for (let m = 0; m < 45; m++) {
      const color = b.toPlay;
      const cands = E.candidateMoves(b, color, E.analyzeBoard(b));
      if (!cands.length) break;
      const st = ai.evalMovesSync(b, KOMI, cands, 30, 110, 3100 + m * 41, 8, color === E.BLACK);
      const mv = ai.chooseAiMove(st, ai.LEVELS[1], rng, cands);
      if (mv < 0) break;
      moves.push({ color: color === E.BLACK ? 'B' : 'W', p: mv });
      b.play(mv, color);
      b.toPlay = 3 - color;
    }
    for (const frac of [0.2, 0.45, 0.7, 0.95]) {
      const k = Math.min(moves.length - 1, Math.floor(moves.length * frac));
      if (k < 0) continue;
      positions.push(moves.slice(0, k + 1));
      if (positions.length >= N_POS) break;
    }
  }
}
console.log(`  ${positions.length} 个局面`);

/* ---------- 2) 逐局面比较 ---------- */
let diffCount = 0, totalLoss = 0, totalAbs = 0, n = 0;
// 诊断：候选（当前权重表） vs 候选（纯手工权重）的选点差异数
// —— 如果这个数是 0，说明「训练表 vs 手工表」根本没区别，
//    瓶颈就不在训练质量，而在评估配比（先验压过 MC）。
const handGO9 = loadSources(
  fs.readFileSync(path.join(ROOT, 'js/ai.js'), 'utf8'),
  fs.readFileSync(path.join(ROOT, 'js/engine.js'), 'utf8'), null);
handGO9.ai.SIM_OPTS.pattern = CAND_PATTERN;
let handDiff = 0;
const rows = [];
const refereeGO9 = REFEREE === 'cand' ? candGO9 : refGO9;
for (let i = 0; i < positions.length; i++) {
  const moves = positions[i];
  const b = rebuild(refGO9, moves);
  const color = b.toPlay;
  const seed = 4242 + i * 131;
  const refMv = pick(refGO9, moves, color, seed);
  const candMv = pick(candGO9, moves, color, seed);
  if (refMv < 0 || candMv < 0) continue;
  if (CAND_PATTERN) {
    const handMv = pick(handGO9, moves, color, seed);
    if (handMv >= 0 && handMv !== candMv) handDiff++;
  }
  if (refMv === candMv) continue;
  const rRef = referee(refereeGO9, moves, refMv, color, 90000 + i * 17);
  const rCand = referee(refereeGO9, moves, candMv, color, 90000 + i * 17);
  if (rRef === null || rCand === null) continue;
  const loss = rRef - rCand;            // 正数 = 候选更差
  totalLoss += loss;
  totalAbs += Math.abs(loss);
  diffCount++; n++;
  rows.push(`  局面${i + 1}（${moves.length} 手）参照 (${refGO9.engine.xOf(refMv)},${refGO9.engine.yOf(refMv)}) ` +
    `候选 (${refGO9.engine.xOf(candMv)},${refGO9.engine.yOf(candMv)})  差 ${loss > 0 ? '+' : ''}${loss.toFixed(1)} 目`);
  if (rows.length % 10 === 0) console.log(`  已比 ${n} 个不同决策…`);
}

console.log('\n逐决策比较：');
for (const r of rows) console.log(r);
console.log(`\n两个引擎选点不同的局面：${diffCount} / ${positions.length}`);
console.log(`候选相对参照的平均目差：${(totalLoss / Math.max(1, diffCount)).toFixed(3)} 目（负=候选更好）`);
console.log(`平均绝对差：${(totalAbs / Math.max(1, diffCount)).toFixed(2)} 目`);
if (CAND_PATTERN) console.log(`诊断：候选(当前权重表) vs 候选(纯手工权重) 选点不同：${handDiff} / ${positions.length}`);
console.log(totalLoss < 0 ? '结论：候选的选点更好 ✓' : totalLoss > 0 ? '结论：候选的选点更差 ✗' : '结论：无差异');
