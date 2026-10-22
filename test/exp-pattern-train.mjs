/* 3×3 策略表的高样本重训器
 * 运行： node test/exp-pattern-train.mjs [选项]
 *
 *   --positions 6000    局面数（每局 4 个采样点）
 *   --plays 250         每个候选的判官评估局数 K（单标签 SD = 28/√K 目）
 *   --cands 8           每局面的候选着法数
 *   --workers 12        并行度（worker_threads）
 *   --beta 0.3          价值→权重的指数系数
 *   --min-samples 20    模式最少样本数（低于此值不调整）
 *   --shrink 0.2        向基线收缩的比例（trust region）
 *   --round 1           第几轮（基线 = 上一轮写出的表）
 *   --dry-run           自检：50 局面 + 串行对照 + 断点续跑校验
 *   --gen-pattern on|off  局面生成时是否开启形状策略（默认 on）
 *   --out js/pattern-weights.js
 *   --stats test/.pattern-stats.json
 *
 * 设计要点（与旧版 exp-pattern-learn.mjs 的区别）：
 *   ① **判官冻结**：标签由 git HEAD 的引擎给出（evalPositionSync，高样本 MC），
 *      绝不用正在被训练的这一套模拟 —— 旧版自参照把胜率准确率从 65.6% 打到 52.1%。
 *   ② **K=250**：单标签 SD 从 14 目降到 1.77 目。
 *   ③ **断点续跑**：每 10 局一个 chunk，统计量增量写 checkpoint。
 *   ④ **并行**：worker_threads，每个 worker 处理不相交的 chunk 区间。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import vm from 'vm';
import { execFileSync } from 'child_process';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const KOMI = 6.5;
const GAMES_PER_POS = 4;           // 每局采样几个局面
const CHUNK_GAMES = 10;            // 一个 chunk 多少局（断点粒度）

/* ================= 公共部分（主线程与 worker 共用） ================= */

function loadGO9(aiSrc, engineSrc, weightsSrc) {
  const ctx = { console, Math, Date, JSON, Map, Set, Array, Object, Number, String, Boolean, Error, isFinite, parseInt, parseFloat };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(engineSrc, ctx);
  vm.runInContext(aiSrc, ctx);
  if (weightsSrc) vm.runInContext(weightsSrc, ctx);
  return ctx.GO9;
}

function gitShow(rel) {
  return execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 24 });
}

/** 在给定引擎里重建某个局面的棋盘 */
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

/** 用候选引擎下出一局，返回局面采样点（每个局面是着法序列） */
function playGame(candGO9, gameSeed, genCoarse, genFine, genRefine, genPattern, maxMoves) {
  const { engine: E, ai } = candGO9;
  const rng = ai.makeRng(gameSeed);
  const b = new E.Board();
  const moves = [];
  const out = [];
  for (let m = 0; m < maxMoves; m++) {
    const color = b.toPlay;
    const cands = E.candidateMoves(b, color, E.analyzeBoard(b));
    if (!cands.length) break;
    const st = ai.evalMovesSync(b, KOMI, cands, genCoarse, genFine, (gameSeed + m * 7919) >>> 0, genRefine, color === E.BLACK);
    const mv = ai.chooseAiMove(st, ai.LEVELS[1], rng, cands);
    if (mv < 0) break;
    moves.push({ color: color === E.BLACK ? 'B' : 'W', p: mv });
    b.play(mv, color);
    b.toPlay = 3 - color;
    // 每 GAMES_PER_POS 手采一个局面
    if (m % Math.max(1, Math.floor(maxMoves / GAMES_PER_POS)) === 0) out.push(moves.slice());
  }
  if (moves.length > 6) out.push(moves.slice());
  return out;
}

/**
 * 给一个局面标注：抽 CAND 个候选，每个用**判官**评估 K 局，
 * 标签 = 候选值 − 同局面候选平均值（相对化）。
 */
function labelPosition(candGO9, judgeGO9, moves, CAND, K, posSeed) {
  const { engine: E, ai: candAi } = candGO9;
  const { engine: JE, ai: judgeAi } = judgeGO9;
  const b = rebuild(candGO9, moves);
  const color = b.toPlay;
  const cands = E.candidateMoves(b, color, E.analyzeBoard(b));
  if (cands.length < 4) return null;

  const rng = candAi.makeRng(posSeed);
  const sample = [];
  const used = new Set();
  for (let k = 0; k < CAND && used.size < cands.length; k++) {
    const i = (rng() * cands.length) | 0;
    if (used.has(i)) continue;
    used.add(i);
    sample.push(cands[i]);
  }
  if (sample.length < 3) return null;

  const vals = [];
  for (const mv of sample) {
    const child = b.clone();
    if (!child.play(mv, color)) { vals.push(null); continue; }
    child.toPlay = 3 - color;
    // 判官：冻结的高样本 MC 评估（mover 视角）
    const pos = judgeAi.evalPositionSync(child, KOMI, K, (posSeed + mv * 131) >>> 0);
    vals.push(color === JE.BLACK ? pos.margin : -pos.margin);
  }
  const ok = vals.filter(v => v !== null);
  if (ok.length < 3) return null;
  const mean = ok.reduce((a, c) => a + c, 0) / ok.length;

  const out = [];
  for (let i = 0; i < vals.length; i++) {
    if (vals[i] === null) continue;
    const pat = judgeAi.patternCode(b, sample[i], color);
    out.push([pat, vals[i] - mean]);
  }
  return out;
}

/* ================= worker ================= */
if (!isMainThread) {
  const W = workerData;
  const candGO9 = loadGO9(W.candAi, W.candEngine, W.weights);
  const judgeGO9 = loadGO9(W.judgeAi, W.judgeEngine, null);
  candGO9.ai.SIM_OPTS.pattern = W.genPattern;
  judgeGO9.ai.SIM_OPTS.pattern = false;          // 判官永远用「无策略」的模拟
  const stats = new Map();
  for (const chunkId of W.chunks) {
    try {
      const chunkStats = new Map();
      for (let g = chunkId * CHUNK_GAMES; g < (chunkId + 1) * CHUNK_GAMES; g++) {
        const gameSeed = (W.seedBase + g * 7919) >>> 0;
        const positions = playGame(candGO9, gameSeed, W.genCoarse, W.genFine, W.genRefine, W.genPattern, W.maxMoves);
        for (let pi = 0; pi < positions.length; pi++) {
          const posSeed = (gameSeed + pi * 104729) >>> 0;
          const labeled = labelPosition(candGO9, judgeGO9, positions[pi], W.cands, W.plays, posSeed);
          if (!labeled) continue;
          for (const [pat, v] of labeled) {
            const rec = chunkStats.get(pat) || { sum: 0, n: 0 };
            rec.sum += v; rec.n++;
            chunkStats.set(pat, rec);
          }
        }
      }
      parentPort.postMessage({ type: 'chunk', chunkId, stats: [...chunkStats.entries()] });
    } catch (e) {
      parentPort.postMessage({ type: 'error', chunkId, message: String(e && e.message || e) });
    }
  }
  parentPort.postMessage({ type: 'done' });
} else {

/* ================= 主线程 ================= */
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const hasFlag = k => argv.includes(k);

const POSITIONS = parseInt(argOf('--positions', '6000'), 10);
let PLAYS = parseInt(argOf('--plays', '250'), 10);
const CANDS = parseInt(argOf('--cands', '8'), 10);
const WORKERS = parseInt(argOf('--workers', '12'), 10);
const BETA = parseFloat(argOf('--beta', '0.3'));
const MIN_SAMPLES = parseInt(argOf('--min-samples', '20'), 10);
const SHRINK = parseFloat(argOf('--shrink', '0.2'));
const ROUND = parseInt(argOf('--round', '1'), 10);
const DRY = hasFlag('--dry-run');
const GEN_PATTERN = argOf('--gen-pattern', 'on') === 'on';
const OUT = path.resolve(ROOT, argOf('--out', 'js/pattern-weights.js'));
const STATS = path.resolve(ROOT, argOf('--stats', 'test/.pattern-stats.json'));
const SEED_BASE = parseInt(argOf('--seed-base', '770000'), 10) + (ROUND - 1) * 10000000;
const GEN_COARSE = parseInt(argOf('--gen-coarse', '8'), 10);
const GEN_FINE = parseInt(argOf('--gen-fine', '30'), 10);
const GEN_REFINE = parseInt(argOf('--gen-refine', '6'), 10);
let MAX_MOVES = parseInt(argOf('--max-moves', '55'), 10);

const N_GAMES = Math.max(1, Math.round(POSITIONS / GAMES_PER_POS));
const N_CHUNKS = Math.ceil(N_GAMES / CHUNK_GAMES);

// 训练是后台长跑，别抢用户正在用的 CPU：优先级降到 BelowNormal（worker 会继承）
try {
  const osmod = await import('os');
  osmod.setPriority(0, 1);
  console.log('  进程优先级：BelowNormal（不抢前台 CPU）');
} catch (e) { /* 某些平台不支持，忽略 */ }

console.log(`3×3 策略表重训（第 ${ROUND} 轮）`);
console.log(`  局面 ${POSITIONS}（${N_GAMES} 局 / ${N_CHUNKS} chunk）  K=${PLAYS}  候选/局面=${CANDS}`);
console.log(`  β=${BETA}  最少样本=${MIN_SAMPLES}  收缩=${SHRINK}  并行=${WORKERS}  局面生成策略=${GEN_PATTERN ? '开' : '关'}`);
console.log(`  判官 = git HEAD 冻结引擎（模拟策略关闭）`);

/* ---------- 加载两套引擎 ---------- */
const candAi = fs.readFileSync(path.join(ROOT, 'js/ai.js'), 'utf8');
const candEngine = fs.readFileSync(path.join(ROOT, 'js/engine.js'), 'utf8');
const weightsPath = path.join(ROOT, 'js/pattern-weights.js');
const weightsSrc = fs.existsSync(weightsPath) ? fs.readFileSync(weightsPath, 'utf8') : null;
const judgeAi = gitShow('js/ai.js');
const judgeEngine = gitShow('js/engine.js');

/* 基准权重表：候选引擎当前的 PAT_W（已叠加现有 pattern-weights.js） */
const candProbe = loadGO9(candAi, candEngine, weightsSrc);
const baseTable = new Uint8Array(candProbe.ai.PAT_W);      // 本轮的基线
const handCrafted = new Uint8Array(candProbe.ai.PAT_W);   // 手工值（用于决定输出哪些条目）
if (weightsSrc) {
  // 重新拿一份「未叠加权重文件」的引擎，得到纯手工值
  const pure = loadGO9(candAi, candEngine, null);
  handCrafted.set(pure.ai.PAT_W);
}
console.log(`  基准表：${weightsSrc ? '已有 pattern-weights.js（作为本轮基线）' : '纯手工权重'}`);

/* ---------- checkpoint ---------- */
let ck = { version: 1, round: ROUND, stats: {}, done: [] };
if (fs.existsSync(STATS)) {
  try {
    const old = JSON.parse(fs.readFileSync(STATS, 'utf8'));
    if (old.version === 1 && old.round === ROUND) {
      ck = old;
      console.log(`  断点续跑：已有 ${Object.keys(ck.stats).length} 个模式的统计，${ck.done.length} 个 chunk 完成`);
    } else {
      console.log('  （checkpoint 的轮次/版本不同，另起新表）');
    }
  } catch (e) { console.log('  （checkpoint 读取失败，另起新表）'); }
}
const doneSet = new Set(ck.done);
const agg = new Map();
for (const [k, v] of Object.entries(ck.stats)) agg.set(+k, { sum: v.sum, n: v.n });

function saveCk() {
  const stats = {};
  for (const [k, v] of agg) stats[k] = { sum: v.sum, n: v.n };
  fs.writeFileSync(STATS, JSON.stringify({ version: 1, round: ROUND, stats, done: [...doneSet] }));
}

/* ---------- 并行跑 chunk ---------- */
let finished = 0, lastReport = Date.now();

/**
 * 并行执行一批 chunk：每个 worker 拿一组互不相交的 chunk，
 * 把「模式 → {sum,n}」增量回传，主线程汇总并写 checkpoint。
 */
async function runAll(workerCount, chunkList) {
  const queue = chunkList.slice();
  if (!queue.length) return;
  const workers = [];
  const chunksPerWorker = Array.from({ length: workerCount }, () => []);
  queue.forEach((c, i) => chunksPerWorker[i % workerCount].push(c));
  await new Promise((resolve) => {
    let alive = 0;
    for (let w = 0; w < workerCount; w++) {
      const worker = new Worker(new URL(import.meta.url), {
        workerData: {
          candAi, candEngine, weights: weightsSrc, judgeAi, judgeEngine,
          chunks: chunksPerWorker[w], seedBase: SEED_BASE, genCoarse: GEN_COARSE, genFine: GEN_FINE,
          genRefine: GEN_REFINE, maxMoves: MAX_MOVES, cands: CANDS, plays: PLAYS,
          genPattern: GEN_PATTERN
        }
      });
      workers.push(worker);
      alive++;
      worker.on('message', (msg) => {
        if (msg.type === 'chunk') {
          for (const [pat, rec] of msg.stats) {
            const cur = agg.get(pat) || { sum: 0, n: 0 };
            cur.sum += rec.sum; cur.n += rec.n;
            agg.set(pat, cur);
          }
          doneSet.add(msg.chunkId);
          finished++;
          if (Date.now() - lastReport > 2000) {
            lastReport = Date.now();
            const pct = (doneSet.size / N_CHUNKS * 100).toFixed(0);
            process.stdout.write(`\r  已完成 ${doneSet.size}/${N_CHUNKS} chunk (${pct}%)  模式数 ${agg.size}   `);
            saveCk();
          }
        } else if (msg.type === 'error') {
          console.error(`\n  chunk ${msg.chunkId} 出错：${msg.message}（该 chunk 不算完成，可重跑）`);
        } else if (msg.type === 'done') {
          alive--;
          if (alive === 0) resolve();
        }
      });
      worker.on('error', (e) => { console.error(`\n  worker 错误：${e.message}`); alive--; if (alive === 0) resolve(); });
    }
    if (!workers.length) resolve();
  });
  for (const w of workers) await w.terminate();
}
/* ---------- dry-run 自检 ---------- */
if (DRY) {
  console.log('\n=== 自检模式 ===');
  const testGames = CHUNK_GAMES;
  // 自检用小一点的 K 与手数（只验一致性，不看信号强度）
  const DRY_PLAYS = Math.min(PLAYS, 20);
  const DRY_MOVES = Math.min(MAX_MOVES, 30);
  // 让并行 worker 也用同样的小预算（workerData 读的就是这两个变量）
  PLAYS = DRY_PLAYS;
  MAX_MOVES = DRY_MOVES;
  // 串行算一遍
  const cGO9 = loadGO9(candAi, candEngine, weightsSrc);
  const jGO9 = loadGO9(judgeAi, judgeEngine, null);
  cGO9.ai.SIM_OPTS.pattern = GEN_PATTERN;
  jGO9.ai.SIM_OPTS.pattern = false;
  const serial = new Map();
  const t0 = Date.now();
  for (let g = 0; g < testGames; g++) {
    const gameSeed = (SEED_BASE + g * 7919) >>> 0;
    const positions = playGame(cGO9, gameSeed, GEN_COARSE, GEN_FINE, GEN_REFINE, GEN_PATTERN, DRY_MOVES);
    for (let pi = 0; pi < positions.length; pi++) {
      const labeled = labelPosition(cGO9, jGO9, positions[pi], CANDS, DRY_PLAYS, (gameSeed + pi * 104729) >>> 0);
      if (!labeled) continue;
      for (const [pat, v] of labeled) {
        const rec = serial.get(pat) || { sum: 0, n: 0 };
        rec.sum += v; rec.n++;
        serial.set(pat, rec);
      }
    }
  }
  console.log(`  串行 ${testGames} 局用时 ${((Date.now() - t0) / 1000).toFixed(1)}s，得到 ${serial.size} 个模式`);
  // 并行算同一个 chunk
  const before = new Map(agg);
  const beforeDone = new Set(doneSet);
  await runAll(Math.min(WORKERS, 4), [0]);
  let maxDiff = 0, totalN = 0;
  for (const [pat, rec] of serial) {
    const par = agg.get(pat);
    if (!par) { maxDiff = Infinity; continue; }
    maxDiff = Math.max(maxDiff, Math.abs(par.sum - rec.sum));
    totalN += rec.n;
  }
  console.log(`  并行 vs 串行：模式数 ${agg.size}（串行 ${serial.size}），求和最大偏差 ${maxDiff.toExponential(2)}`);
  console.log(`  样本总数 ${totalN}，平均每模式 ${(totalN / Math.max(1, agg.size)).toFixed(1)} 个`);
  console.log(maxDiff < 0.01 ? '  ✓ 并行与串行一致' : '  ✗ 并行与串行不一致');
  // 断点续跑校验：清掉再跑一次，看结果是否相同
  const snapshot = new Map(agg);
  const doneSnapshot = new Set(doneSet);
  agg.clear(); doneSet.clear();
  await runAll(Math.min(WORKERS, 4), [0]);
  let resumeDiff = 0;
  for (const [pat, rec] of snapshot) {
    const now = agg.get(pat);
    if (!now) { resumeDiff = Infinity; break; }
    resumeDiff = Math.max(resumeDiff, Math.abs(now.sum - rec.sum));
  }
  console.log(`  断点续跑：重跑同一 chunk 求和最大偏差 ${resumeDiff.toExponential(2)}`);
  console.log(resumeDiff < 0.01 ? '  ✓ 断点续跑一致' : '  ✗ 断点续跑不一致');
  process.exit(0);
}

/* ---------- 正式训练 ---------- */
const todo = [];
for (let c = 0; c < N_CHUNKS; c++) if (!doneSet.has(c)) todo.push(c);
if (!todo.length) console.log('  所有 chunk 都已完成，直接出表');
const tStart = Date.now();
if (todo.length) await runAll(WORKERS, todo);
process.stdout.write('\n');
saveCk();
console.log(`\n  训练完成：${doneSet.size}/${N_CHUNKS} chunk，用时 ${((Date.now() - tStart) / 60000).toFixed(1)} 分钟`);

/* ---------- 统计与出表 ---------- */
const rows = [];
for (const [pat, rec] of agg) rows.push({ pat, v: rec.sum / rec.n, n: rec.n });
rows.sort((a, b) => b.v - a.v);
const reliable = rows.filter(r => r.n >= MIN_SAMPLES);
console.log(`\n  统计到 ${rows.length} 个模式，其中样本 ≥ ${MIN_SAMPLES} 的有 ${reliable.length} 个`);
console.log('  最有价值的形状：');
for (const r of reliable.slice(0, 8)) console.log(`    模式 ${r.pat}: 价值 ${r.v.toFixed(2)} 目（样本 ${r.n}）`);
console.log('  最差的形状：');
for (const r of reliable.slice(-5)) console.log(`    模式 ${r.pat}: 价值 ${r.v.toFixed(2)} 目（样本 ${r.n}）`);

const LO = 6, HI = 60;
const table = {};
let changed = 0;
for (const r of rows) {
  if (r.n < MIN_SAMPLES) continue;
  const base = baseTable[r.pat];
  let w = base * Math.exp(BETA * r.v);
  if (w < LO) w = LO; if (w > HI) w = HI;
  w = base + (w - base) * (1 - SHRINK);        // trust region：向基线收缩
  const wi = Math.max(1, Math.round(w));
  if (wi !== handCrafted[r.pat]) { table[r.pat] = wi; changed++; }
}
console.log(`\n  调整了 ${changed} 个模式的权重（共 ${rows.length} 个有样本，${reliable.length} 个达门槛）`);

/* ---------- 写出 js/pattern-weights.js ---------- */
const body = `/* 3×3 局部形状策略的权重表
 *
 * 由 test/exp-pattern-train.mjs 用「自对弈 + 冻结判官」训练得到（第 ${ROUND} 轮）。
 * 训练参数：局面 ${POSITIONS}，每候选 K=${PLAYS} 局，候选/局面 ${CANDS}，
 *           β=${BETA}，最少样本 ${MIN_SAMPLES}，收缩 ${SHRINK}。
 * 标签来自 git HEAD 的冻结引擎（高样本 MC 评估），不是策略自己的模拟 ——
 * 自参照会把噪声当信号（第一版就是这么把胜率准确率从 65.6% 打到 52.1% 的）。
 *
 * 键：对称归一化后的 3×3 模式编号（0..6560）
 * 值：权重（放大 16 倍的整数）；未出现的模式沿用 js/ai.js 里的手工初始权重。
 *
 * 生成时间：${new Date().toISOString()}
 */
(function (g) {
  const T = ${JSON.stringify(table)};
  const api = g.GO9 && g.GO9.ai;
  if (api && api.applyPatternWeights) api.applyPatternWeights(T);
})(typeof window !== 'undefined' ? window : globalThis);
`;
fs.writeFileSync(OUT, body, 'utf8');
console.log(`  已写出：${path.relative(ROOT, OUT)}（${Object.keys(table).length} 个条目）`);
console.log(`  checkpoint：${path.relative(ROOT, STATS)}`);

}   // end of else (主线程)
