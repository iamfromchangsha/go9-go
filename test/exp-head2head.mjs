/* 擂台：两个引擎版本正面对弈，用胜率衡量「棋力」
 * 运行： node test/exp-head2head.mjs [参照版本说明]
 *
 * 用法：
 *   node test/exp-head2head.mjs                    # 工作区(候选) vs HEAD(参照)
 *   node test/exp-head2head.mjs --ref HEAD~1       # 对比更早的版本
 *   node test/exp-head2head.mjs --games 24
 *
 * 做法：两边在同一盘棋上轮流走，各自用自己的评估管线选点；
 *      终局用同一套计分（面积计子 + 模拟判死活）。
 *      交替执黑，先手方不固定，避免「先手优势」污染结论。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import vm from 'vm';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/* ---------- 参数 ---------- */
const argv = process.argv.slice(2);
const argOf = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const REF = argOf('--ref', 'HEAD');
const GAMES = parseInt(argOf('--games', '16'), 10);
const KOMI = 6.5;
const LEVEL_KEY = argOf('--level', 'l4');
const COARSE = parseInt(argOf('--coarse', '60'), 10);
const FINE = parseInt(argOf('--fine', '220'), 10);
const REFINE = parseInt(argOf('--refine', '14'), 10);

/* ---------- 加载两套引擎 ---------- */
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

const refGO9 = loadSources(gitShow('js/ai.js'), gitShow('js/engine.js'));
// 候选方要带上训练出来的 3×3 权重（浏览器里 index.html 也会加载它）
const PW = path.join(ROOT, 'js/pattern-weights.js');
const candGO9 = loadSources(
  fs.readFileSync(path.join(ROOT, 'js/ai.js'), 'utf8'),
  fs.readFileSync(path.join(ROOT, 'js/engine.js'), 'utf8'),
  fs.existsSync(PW) ? fs.readFileSync(PW, 'utf8') : null
);
// 验收闸门用：
//   --candidate-pattern on|off  候选引擎是否开 3×3 策略（默认 off）
//   --ref-pattern on|off       参照引擎是否开（默认 off）
//   --ref-weights <文件>       参照引擎加载的权重表（默认不加载 = 手工权重）
//   --weights <文件>           候选引擎加载的权重表（默认 js/pattern-weights.js）
const CAND_PATTERN = argOf('--candidate-pattern', 'off') === 'on';
const REF_PATTERN = argOf('--ref-pattern', 'off') === 'on';
const REFW = argOf('--ref-weights', '');
const CANDW = argOf('--weights', '');
{
  const loadW = p => (p && fs.existsSync(path.resolve(ROOT, p)) ? fs.readFileSync(path.resolve(ROOT, p), 'utf8') : null);
  const refSrc = loadW(REFW);
  if (refSrc) {
    const r = loadSources(gitShow('js/ai.js'), gitShow('js/engine.js'), refSrc);
    refGO9.engine = r.engine; refGO9.ai = r.ai;
  }
  const candSrc = loadW(CANDW);
  if (candSrc) {
    const c = loadSources(
      fs.readFileSync(path.join(ROOT, 'js/ai.js'), 'utf8'),
      fs.readFileSync(path.join(ROOT, 'js/engine.js'), 'utf8'), candSrc);
    candGO9.engine = c.engine; candGO9.ai = c.ai;
  }
  refGO9.ai.SIM_OPTS.pattern = REF_PATTERN;
  candGO9.ai.SIM_OPTS.pattern = CAND_PATTERN;
  console.log(`策略开关：候选=${CAND_PATTERN ? '开' : '关'}  参照=${REF_PATTERN ? '开' : '关'}` +
    `${CANDW ? `  候选权重表=${CANDW}` : ''}${REFW ? `  参照权重表=${REFW}` : ''}`);
}

/* ---------- 用某一方的规则重建棋盘 ---------- */
function rebuild(GO9, moves) {
  const { engine: E } = GO9;
  const { idx, BLACK, WHITE, Board } = E;
  const b = new Board();
  for (const mv of moves) {
    const c = mv.color === 'B' ? BLACK : WHITE;
    if (mv.p < 0) { b.passTurn(); b.toPlay = 3 - c; continue; }
    b.play(mv.p, c);
    b.toPlay = 3 - c;
  }
  return b;
}

/* ---------- 让某一方选一手 ---------- */
function chooseMove(GO9, moves, color, seed) {
  const { engine: E, ai } = GO9;
  const b = rebuild(GO9, moves);
  const cands = E.candidateMoves(b, color, E.analyzeBoard(b));
  if (!cands.length) return -1;
  const level = ai.LEVELS.find(l => l.key === LEVEL_KEY) || ai.LEVELS[3];
  const stats = ai.evalMovesSync(b, KOMI, cands, COARSE, FINE, seed, REFINE, color === E.BLACK);
  const rng = ai.makeRng(seed ^ 0x9e3779b9);
  return ai.chooseAiMove(stats, level, rng, cands);
}

/* ---------- 终局计分（用参照方的引擎算，死活判定靠模拟） ---------- */
function score(GO9, moves) {
  const { engine: E, ai } = GO9;
  const b = rebuild(GO9, moves);
  const fs = ai.finalScore(b, KOMI, 200, ai.makeRng(1234567));
  return { black: fs.black, white: fs.white, diff: fs.diff };
}

/* ---------- 跑一局 ---------- */
function playGame(gameIdx) {
  const moves = [];
  let seed = 90000 + gameIdx * 7919;
  const firstIsCandidate = gameIdx % 2 === 0;   // 交替先手
  let color = 1;                                // 1 = 黑
  for (let ply = 0; ply < 120; ply++) {
    const candTurn = (color === 1) === firstIsCandidate;
    const GO9 = candTurn ? candGO9 : refGO9;
    const mv = chooseMove(GO9, moves, color, (seed += 131));
    if (mv < 0) {
      moves.push({ color: color === 1 ? 'B' : 'W', p: -1 });
      if (moves.length >= 2 && moves[moves.length - 1].p < 0 && moves[moves.length - 2].p < 0) break;
      color = 3 - color;
      continue;
    }
    moves.push({ color: color === 1 ? 'B' : 'W', p: mv });
    color = 3 - color;
  }
  const sc = score(refGO9, moves);
  // 候选方得分：黑分差换算成候选方视角
  const candIsBlack = firstIsCandidate;
  const candDiff = candIsBlack ? sc.diff : -sc.diff;
  return { candDiff, black: sc.black, white: sc.white, moves: moves.length, candIsBlack };
}

/* ---------- 跑 ---------- */
console.log(`擂台：工作区(候选) vs ${REF}(参照)   ${GAMES} 局，难度 ${LEVEL_KEY}，贴目 ${KOMI}`);
console.log(`评估预算：粗评 ${COARSE} / 精评 ${FINE} / 精评候选 ${REFINE}\n`);
let candWins = 0, refWins = 0, draws = 0, sumDiff = 0;
const details = [];
for (let g = 0; g < GAMES; g++) {
  const r = playGame(g);
  sumDiff += r.candDiff;
  if (r.candDiff > 0) candWins++;
  else if (r.candDiff < 0) refWins++;
  else draws++;
  details.push(`  第${g + 1}局 候选${r.candDiff > 0 ? '胜' : r.candDiff < 0 ? '负' : '和'} ` +
    `（${r.black}:${r.white}，候选视角 ${r.candDiff > 0 ? '+' : ''}${r.candDiff} 目，${r.moves} 手）`);
  console.log(details[details.length - 1]);
}
const n = GAMES;
console.log(`\n候选 ${candWins} 胜 / 参照 ${refWins} 胜 / ${draws} 和`);
console.log(`候选胜率 ${(candWins / n * 100).toFixed(1)}%（含和棋 ${((candWins + draws / 2) / n * 100).toFixed(1)}%）`);
console.log(`候选平均目差 ${(sumDiff / n).toFixed(2)}（正=候选占优）`);
console.log(candWins / n >= 0.6 ? '\n结论：候选明显更强 ✓' :
  candWins / n <= 0.4 ? '\n结论：候选明显更弱 ✗' : '\n结论：与参照无显著差异');
