/* 干净的 A/B：同一批局面下，两个引擎给出的「胜率」谁更能预示终局
 * 运行： node test/exp-wr-accuracy-ab.mjs [--games 4] [--sims 400]
 *
 * 为什么另写一个：eval-quality.mjs 里的对局是「被测引擎自己下的」，
 * 换引擎就换了局面，两边的数字没法直接比。
 * 这里改成：**对局统一由参照引擎下**（局面完全相同），
 * 然后分别用两个引擎评估同一批局面的胜率，再跟真实终局结果比符号一致率。
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
const SIMS = parseInt(argOf('--sims', '400'), 10);
const KOMI = 6.5;

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

console.log(`同一批局面（对局统一由 ${REF} 下），比较两个引擎的胜率预测力…\n`);
const samples = [];
{
  const { engine: E, ai } = refGO9;
  for (let g = 0; g < GAMES; g++) {
    const rng = ai.makeRng(1000 + g * 77);
    const b = new E.Board();
    const moves = [];
    for (let mv = 0; mv < 60; mv++) {
      const color = b.toPlay;
      const cands = E.candidateMoves(b, color, E.analyzeBoard(b));
      if (!cands.length) break;
      const st = ai.evalMovesSync(b, KOMI, cands, 60, 220, 5000 + g * 131 + mv * 17, 14, color === E.BLACK);
      const m2 = ai.chooseAiMove(st, ai.LEVELS[1], rng, cands);
      if (m2 < 0) break;
      moves.push({ color: color === E.BLACK ? 'B' : 'W', p: m2 });
      b.play(m2, color);
      b.toPlay = 3 - color;
      if (mv % 5 === 0) samples.push(moves.slice());
    }
  }
}
console.log(`采样 ${samples.length} 个局面`);

function evaluate(GO9, label) {
  const { engine: E, ai } = GO9;
  let agree = 0, total = 0;
  const pairs = [];
  for (let i = 0; i < samples.length; i++) {
    const moves = samples[i];
    const b = rebuild(GO9, moves);
    const pos = ai.evalPositionSync(b, KOMI, SIMS, ai.makeRng(90000 + i * 37));
    // 终局结果：用参照引擎跑到底的面积分（两边同一套规则）
    const bfull = rebuild(refGO9, moves);
    const fs = refGO9.ai.finalScore(bfull, KOMI, 200, ai.makeRng(1234567));
    const blackWon = fs.diff > 0;
    if ((pos.winRate > 0.5) === blackWon) agree++;
    total++;
    pairs.push({ mc: pos.margin, final: fs.diff });
  }
  const fin = pairs.map(p => p.final), mc = pairs.map(p => p.mc);
  const mx = mc.reduce((a, c) => a + c, 0) / mc.length, my = fin.reduce((a, c) => a + c, 0) / fin.length;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < mc.length; i++) {
    const dx = mc[i] - mx, dy = fin[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  const r = sxy / Math.sqrt(sxx * syy);
  const bias = pairs.reduce((a, p) => a + (p.mc - p.final), 0) / pairs.length;
  console.log(`  ${label.padEnd(14)} 符号一致率 ${(agree / total * 100).toFixed(1)}%（${agree}/${total}）` +
    `  与终局目差相关 ${r.toFixed(3)}  平均偏差 ${bias.toFixed(1)} 目`);
  return agree / total;
}

const a = evaluate(refGO9, `参照 ${REF}`);
const b2 = evaluate(candGO9, '候选 工作区');
console.log(`\n差值：${((b2 - a) * 100).toFixed(1)} 个百分点`);
console.log(b2 > a + 0.05 ? '结论：候选的胜率更能预示终局 ✓'
  : b2 < a - 0.05 ? '结论：候选的胜率更不准 ✗' : '结论：两者无显著差异');
