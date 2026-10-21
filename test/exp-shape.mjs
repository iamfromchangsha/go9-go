/* 配对对照：工作区引擎 vs 参照版本，同一批种子，各下 N 局
 * 运行： node test/exp-shape.mjs [--ref HEAD] [--games 4]
 *
 * 对比指标（都是「行为」而不是「评估分数」，方差小得多）：
 *   1. 终局棋子线位分布（形状）—— 真实棋局大致是 线0 10% / 线1 20% / 线2 30% / 线3 25% / 线4 15%
 *   2. 自杀手率 / 漏提率 / 填自己眼率
 *   3. 终局平均目差
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
const COARSE = 60, FINE = 220, REFINE = 14, KOMI = 6.5;

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
const engines = {
  ['参照 ' + REF]: loadSources(gitShow('js/ai.js'), gitShow('js/engine.js')),
  ['候选 工作区']: loadSources(
    fs.readFileSync(path.join(ROOT, 'js/ai.js'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'js/engine.js'), 'utf8'))
};

/* ---- 失误检测（在给定引擎的规则下） ---- */
function makeDetectors(GO9) {
  const { engine: E } = GO9;
  const lineOf = p => Math.min(E.xOf(p), 8 - E.xOf(p), E.yOf(p), 8 - E.yOf(p));
  function isSelfAtari(b, p, color) {
    const c = b.clone();
    const opp = 3 - color;
    const capBefore = c.caps[color];
    if (!c.play(p, color)) return false;
    if (c.caps[color] > capBefore) return false;
    return E.groupStats(c, p).libs <= 1;
  }
  function inOwnEye(b, p, color) {
    const c = b.clone();
    if (!c.play(p, color)) return false;
    c.stones[p] = 0;
    const ana = E.analyzeBoard(c);
    const seen = new Uint8Array(121);
    const stack = [p]; seen[p] = 1;
    let size = 0, hasB = false, hasW = false;
    while (stack.length) {
      const cur = stack.pop(); size++;
      for (const n of E.NEI[cur]) {
        if (c.stones[n] === 0) { if (!seen[n]) { seen[n] = 1; stack.push(n); } }
        else if (c.stones[n] === 1) hasB = true;
        else if (c.stones[n] === 2) hasW = true;
      }
    }
    return size >= 2 && hasB && !hasW;
  }
  function captureSpot(b, color) {
    const opp = 3 - color;
    const ana = E.analyzeBoard(b);
    for (let p = 0; p < 121; p++) {
      if (b.stones[p] !== opp) continue;
      if (ana.libs[p] !== 1) continue;
      const g = E.groupStats(b, p);
      if (g.ata >= 0 && g.ata !== b.ko) return g.ata;
    }
    return -1;
  }
  return { lineOf, isSelfAtari, inOwnEye, captureSpot };
}

function playAll(GO9, label) {
  const { engine: E, ai } = GO9;
  const D = makeDetectors(GO9);
  const agg = { selfAtari: 0, missed: 0, missed2: 0, ownEye: 0, total: 0, lineHist: {}, diffSum: 0, games: 0 };
  for (let g = 0; g < GAMES; g++) {
    const rng = ai.makeRng(20261021 + g * 7919);
    const b = new E.Board();
    const level = ai.LEVELS.find(l => l.key === 'l4');
    for (let m = 0; m < 70; m++) {
      const color = b.toPlay;
      const cands = E.candidateMoves(b, color, E.analyzeBoard(b));
      if (!cands.length) break;
      const st = ai.evalMovesSync(b, KOMI, cands, COARSE, FINE, 3000 + g * 977 + m * 31, REFINE, color === E.BLACK);
      const mv = ai.chooseAiMove(st, level, rng, cands);
      if (mv < 0) break;
      agg.total++;
      if (D.isSelfAtari(b, mv, color)) agg.selfAtari++;
      if (D.inOwnEye(b, mv, color)) agg.ownEye++;
      const cap = D.captureSpot(b, color);
      if (cap >= 0 && cap !== mv) { agg.missed++; const g2 = E.groupStats(b, cap); if (g2 && g2.size >= 2) agg.missed2++; }
      b.play(mv, color);
      b.toPlay = 3 - color;
    }
    // 终局：棋子线位分布 + 目差
    for (let p = 0; p < 121; p++) {
      const s = b.stones[p];
      if (s !== 1 && s !== 2) continue;
      const d = D.lineOf(p);
      agg.lineHist[d] = (agg.lineHist[d] || 0) + 1;
    }
    const fs = ai.finalScore(b, KOMI, 200, rng);
    agg.diffSum += fs.diff;
    agg.games++;
  }
  return agg;
}

console.log(`配对对照：同一种子各下 ${GAMES} 局（参照 ${REF} vs 工作区）\n`);
const results = {};
for (const [label, GO9] of Object.entries(engines)) {
  const t0 = Date.now();
  results[label] = playAll(GO9, label);
  console.log(`  ${label} 用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

for (const [label, a] of Object.entries(results)) {
  const total = Object.values(a.lineHist).reduce((x, y) => x + y, 0);
  const pct = d => (((a.lineHist[d] || 0) / total) * 100).toFixed(1);
  console.log(`\n=== ${label} ===`);
  console.log(`  终局棋子线位分布：线0 ${pct(0)}%  线1 ${pct(1)}%  线2 ${pct(2)}%  线3 ${pct(3)}%  线4 ${pct(4)}%   （共 ${total} 颗子）`);
  console.log('  真实棋局参考：    线0  10%  线1  20%  线2  30%  线3  25%  线4  15%');
  console.log(`  自杀手 ${a.selfAtari}/${a.total} (${(a.selfAtari / a.total * 100).toFixed(1)}%)` +
    `   漏吃子 ${a.missed}/${a.total} (${(a.missed / a.total * 100).toFixed(1)}%)` +
    `   漏提≥2子 ${a.missed2}   填自己眼 ${a.ownEye} (${(a.ownEye / a.total * 100).toFixed(1)}%)`);
  console.log(`  终局平均目差（黑−白，含贴目）：${(a.diffSum / a.games).toFixed(1)}`);
}
