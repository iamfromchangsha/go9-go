/* 九路围棋引擎自测：规则正确性 / 自对弈稳定性 / 速度基准
 * 运行： node test/run-tests.mjs
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
const { idx, BLACK, WHITE, EMPTY, Board } = E;

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

/* ---------- 工具 ---------- */
function mkBoard(stones, toPlay = BLACK, trackSuperko = false) {
  const b = new Board();
  b.toPlay = toPlay;
  for (const [x, y, c] of stones) {
    b.stones[idx(x, y)] = c;
    b.toggle(idx(x, y), c);
  }
  if (trackSuperko) {
    // 注意：必须在摆好棋子之后再登记初始局面哈希，否则登记的是空盘
    b.hist = new Map();
    b.trackSuperko = true;
    b.hist.set(b.hash(), true);
  }
  return b;
}

/* ---------- 1. 提子 ---------- */
section('提子');
{
  const b = mkBoard([[0, 0, WHITE]]);          // 白子只剩 (1,0) 一口气
  ok(b.play(idx(1, 0), BLACK), '堵住最后一口气合法');
  const played = b.play(idx(0, 1), BLACK);    // 提掉白子
  ok(played, '提子这手合法');
  ok(b.stones[idx(0, 0)] === EMPTY, '白子被提掉');
  ok(b.caps[BLACK] === 1, '提子计数 = 1');
}

/* ---------- 2. 自杀禁止 ---------- */
section('自杀禁止');
{
  // 黑 (1,0) 四周被白子封住，黑下 (0,0) 后整块无气 → 自杀
  const b = mkBoard([
    [0, 1, WHITE], [1, 1, WHITE], [2, 0, WHITE], [1, 0, BLACK]
  ]);
  const r = b.play(idx(0, 0), BLACK);
  ok(r === false, '自杀着法被拒绝');
  ok(b.stones[idx(0, 0)] === EMPTY, '棋盘未被污染');
}

/* ---------- 3. 打劫 ---------- */
section('打劫');
{
  // 白 (2,1) 只剩 (2,0) 一口气，黑 (2,0) 提子后只剩 (2,1) 一口气 → 劫
  const b = mkBoard([
    [1, 1, BLACK], [3, 1, BLACK], [2, 2, BLACK],
    [2, 1, WHITE], [1, 0, WHITE], [3, 0, WHITE]
  ]);
  const cap = b.play(idx(2, 0), BLACK);
  ok(cap, '黑提白 (2,1) 合法');
  ok(b.stones[idx(2, 1)] === EMPTY, '白子被提');
  ok(b.ko === idx(2, 1), '劫点被正确记录');
  ok(b.play(idx(2, 1), WHITE) === false, '立即回提被禁止（劫）');
  // 打劫之后：轮走两手，劫解禁
  b.play(idx(0, 0), WHITE);
  b.play(idx(5, 5), BLACK);
  ok(b.play(idx(2, 1), WHITE) === true, '两手之后回提合法');
  ok(b.stones[idx(2, 0)] === EMPTY, '回提后黑子被提');
}

/* ---------- 4. 超级劫（全局同形禁止） ---------- */
section('超级劫');
{
  // 劫形局面：黑提白 (2,1) 后形成劫；白停一手、黑停一手后回提 → 回到已出现过的局面
  const b = mkBoard([
    [1, 1, BLACK], [3, 1, BLACK], [2, 2, BLACK],
    [2, 1, WHITE], [1, 0, WHITE], [3, 0, WHITE]
  ], BLACK, true);
  b.play(idx(2, 0), BLACK);      // 黑提白 (2,1)
  b.toPlay = WHITE;
  b.passTurn(); b.toPlay = BLACK;   // 白停
  b.passTurn(); b.toPlay = WHITE;   // 黑停
  const recapture = b.play(idx(2, 1), WHITE);   // 回提 → 回到最初的局面
  ok(recapture === false, '回到已出现过的局面被禁止（超级劫）');
  ok(b.stones[idx(2, 0)] === BLACK, '黑子仍在盘上');
}

/* ---------- 5. 计分 ---------- */
section('计分');
{
  // 黑占左 4 列，白占右 4 列，中间第 5 列为双方公气（无主）
  const b = mkBoard([]);
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 4; x++) b.stones[idx(x, y)] = BLACK;
    for (let x = 5; x < 9; x++) b.stones[idx(x, y)] = WHITE;
  }
  const sc = E.areaScore(b);
  ok(sc.black === 36, `黑棋面积 = 36（实际 ${sc.black}）`);
  ok(sc.white === 36, `白棋面积 = 36（实际 ${sc.white}）`);
}

/* ---------- 6. 合法性辅助函数 ---------- */
section('合法性辅助');
{
  const b = mkBoard([[0, 1, WHITE], [1, 1, WHITE], [2, 0, WHITE], [1, 0, BLACK]]);
  ok(E.isLegalMove(b, idx(0, 0), BLACK) === false, 'isLegalMove 识别自杀');
  ok(E.isLegalMove(b, idx(4, 4), BLACK) === true, 'isLegalMove 识别正常着法');
  ok(b.stones[idx(4, 4)] === EMPTY, 'isLegalMove 不污染棋盘');
  const h0 = b.hash();
  E.isLegalMove(b, idx(4, 4), BLACK);
  ok(b.hash() === h0, 'isLegalMove 不污染哈希');
}

/* ---------- 6b. isLegalMove 不得污染超级劫表 ---------- */
section('合法性试探与超级劫');
{
  const b = mkBoard([], BLACK, true);
  const histSize0 = b.hist.size;
  E.isLegalMove(b, idx(4, 4), BLACK);
  ok(b.hist.size === histSize0, '试探后超级劫表条目数不变', b.hist.size);
  ok(b.play(idx(4, 4), BLACK) === true, '试探后同一手仍可正常落子（不被误判为重复局面）');
  ok(b.stones[idx(4, 4)] === BLACK, '棋子确实落在盘上');
}

/* ---------- 7. 自对弈稳定性 ---------- */
section('自对弈（引擎 vs 引擎）');
{
  const rng = ai.makeRng(12345);
  let games = 0, illegal = 0, crash = 0, totalMoves = 0;
  for (let g = 0; g < 6; g++) {
    const b = new Board();
    b.hist = new Map(); b.trackSuperko = true; b.hist.set(b.hash(), true);
    let moves = 0;
    try {
      while (moves < 160) {
        const ana = E.analyzeBoard(b);
        const cands = E.candidateMoves(b, b.toPlay, ana);
        if (!cands.length) { b.passTurn(); if (b.passes >= 2) break; moves++; continue; }
        const p = cands[(rng() * cands.length) | 0];
        if (!b.play(p, b.toPlay)) { illegal++; }
        else { b.toPlay = 3 - b.toPlay; }
        moves++;
      }
      const fs = ai.finalScore(b, 6.5, 120, rng);
      if (typeof fs.diff !== 'number') crash++;
      games++;
      totalMoves += moves;
    } catch (e) {
      crash++;
      console.log('    异常：', e.message);
    }
  }
  ok(crash === 0, '自对弈无异常', crash + ' 局崩溃');
  ok(games === 6, `完成 ${games}/6 局`);
  ok(illegal === 0, '自对弈无非法着法', illegal + ' 次');
  ok(totalMoves / games > 60, `平均手数 ${(totalMoves / games).toFixed(1)} 合理`);
}

/* ---------- 8. 速度基准 ---------- */
section('速度基准');
{
  const rng = ai.makeRng(777);
  const b = new Board();
  for (let i = 0; i < 20; i++) {
    const p = idx(2 + (i % 5), 2 + ((i / 5) | 0));
    if (b.stones[p] === EMPTY) { b.play(p, b.toPlay); b.toPlay = 3 - b.toPlay; }
  }
  const cfg = { playouts: 2000, c: 0.95, noise: 0, komi: 6.5, sim: ai.SIM_OPTS };
  const t0 = Date.now();
  const s = ai.createSearch(b, cfg, rng);
  let done = false;
  while (!done) done = s.step(500);
  const dt = Date.now() - t0;
  const per = dt / 2000;
  console.log(`  2000 次模拟耗时 ${dt}ms → 每次 ${per.toFixed(3)}ms（≈${Math.round(1000 / per)} 次/秒）`);
  ok(dt < 8000, '2000 次模拟在 8 秒内完成', dt + 'ms');

  const summary = ai.summarize(s.root, 6.5);
  ok(summary.stats.size > 0, `根节点候选着法 ${summary.stats.size} 个`);
  ok(summary.winRate > 0 && summary.winRate < 1, `根胜率 ${(summary.winRate * 100).toFixed(1)}% 合法`);
}

/* ---------- 9. 着法品质判定 ---------- */
section('着法品质判定（按噪声带分级）');
{
  const BAND = 0.045;      // 噪声带 ±4.5 个百分点
  // margin = 混合评估值（目差尺度），差距 = (best.margin - played.margin) / 16
  const stats = new Map([
    [idx(0, 0), { wr: 0.80, margin: 0.00, visits: 120 }],   // 最佳
    [idx(1, 1), { wr: 0.78, margin: -0.20, visits: 90 }],    // 差 0.8 目 → 噪声内
    [idx(5, 5), { wr: 0.74, margin: -0.80, visits: 80 }],    // 差 3.2 目 → 两倍噪声
    [idx(4, 4), { wr: 0.70, margin: -2.00, visits: 60 }],    // 差 8.0 目 → 俗手
    [idx(2, 2), { wr: 0.60, margin: -2.88, visits: 50 }],    // 差 11.5 目 → 大幅落后
    [idx(3, 3), { wr: 0.42, margin: -4.00, visits: 30 }]
  ]);
  const best = idx(0, 0), bestWR = 0.80, bestMargin = 0.00;
  const grade = (mv, black) => ai.gradeMove(stats, mv, black, best, bestWR, BAND, bestMargin).grade;
  ok(grade(best, true) === 'good', '最佳着法 → 好手');
  ok(grade(idx(1, 1), true) === 'good', '噪声内的差距 → 好手（不误判为失误）');
  ok(grade(idx(5, 5), true) === 'ordinary', '超出噪声一倍 → 普通');
  ok(grade(idx(4, 4), true) === 'mundane', '超出噪声三倍半 → 俗手');
  ok(grade(idx(2, 2), true) === 'blunder', '大幅落后 → 恶手');

  // margin 现在一律是「行棋方视角」（越高＝对行棋方越有利），
  // 所以同一张表在黑白两种颜色下方向必须一致 —— 不随颜色翻转。
  const gB = ai.gradeMove(stats, idx(2, 2), true, best, bestWR, BAND, bestMargin);
  const gW = ai.gradeMove(stats, idx(2, 2), false, best, bestWR, BAND, bestMargin);
  ok(gW.grade === 'blunder' && gB.grade === gW.grade,
    '评估表以行棋方为基准（同一张表方向不随颜色翻转）', `${gB.grade}/${gW.grade}`);

  // 白方视角：margin 高于引擎最佳值 ⇒ 对白方是妙手
  const stats2 = new Map([
    [idx(0, 0), { wr: 0.80, margin: 0.00, visits: 120 }],
    [idx(5, 5), { wr: 0.86, margin: 0.90, visits: 40 }]
  ]);
  ok(ai.gradeMove(stats2, idx(5, 5), false, idx(0, 0), 0.80, BAND, 0.00).grade === 'brilliant',
    '白方视角：margin 优于引擎最佳 → 妙手');
  // 超出引擎最佳着法的好手 → 妙手
  ok(ai.gradeMove(stats2, idx(5, 5), true, idx(0, 0), 0.80, BAND, 0.00).grade === 'brilliant', '好于引擎最佳着法 → 妙手');

  // 噪声带估算
  const band3 = ai.noiseBandOf(160), band5 = ai.noiseBandOf(400);
  ok(band3 > band5, `模拟越多噪声越小（160次→${(band3 * 100).toFixed(1)}pt，400次→${(band5 * 100).toFixed(1)}pt）`);
  ok(band3 > 0.008 && band3 < 0.05, '噪声带量级合理（混合后更小）');
}

/* ---------- 9b. 静态势力评估 ---------- */
section('静态势力评估');
{
  // 空盘：没有边界子，静态分为 0
  const empty = new Board();
  ok(ai.staticScore(empty) === 0, '空盘静态分为 0', ai.staticScore(empty));

  // 静态评估本身是确定性的（零随机噪声）
  const b = new Board();
  for (const [x, y] of [[5, 0], [5, 1], [5, 2], [5, 3], [5, 4]]) { b.stones[idx(x, y)] = BLACK; b.toggle(idx(x, y), BLACK); }
  for (const [x, y] of [[0, 6], [1, 6], [2, 6], [3, 6]]) { b.stones[idx(x, y)] = WHITE; b.toggle(idx(x, y), WHITE); }
  const s1 = ai.staticScore(b);
  ok(typeof s1 === 'number', '静态分可计算（' + s1 + '）', s1);
  ok(ai.staticScore(b) === s1, '静态评估是确定性的（零随机噪声）');

  // 评估管线里用的是「增量」：static(落子后) - static(落子前)
  // 提子应当让静态分明显上升（赚到了地）
  const cap = new Board();
  for (const [x, y] of [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1]]) { cap.stones[idx(x, y)] = WHITE; cap.toggle(idx(x, y), WHITE); }
  for (const [x, y] of [[3, 0], [3, 1], [2, 1], [0, 2]]) { cap.stones[idx(x, y)] = BLACK; cap.toggle(idx(x, y), BLACK); }
  const before = ai.staticScore(cap);
  const after = cap.clone();
  after.play(idx(1, 2), BLACK);
  const delta = ai.staticScore(after) - before;
  ok(delta > 0, '提子后静态增量上升（' + delta + '）', delta);
}
/* ---------- 10. 引擎判读：能否认出该提的一手 ---------- */
section('引擎判读（配对模拟评估）');
{
  const rng = ai.makeRng(99);
  const b = new Board();
  // 白五子只剩 (1,2) 一口气：不提则白能活（提掉净赚 5 目），提则白净死
  b.stones[idx(0, 0)] = WHITE; b.toggle(idx(0, 0), WHITE);
  b.stones[idx(1, 0)] = WHITE; b.toggle(idx(1, 0), WHITE);
  b.stones[idx(2, 0)] = WHITE; b.toggle(idx(2, 0), WHITE);
  b.stones[idx(0, 1)] = WHITE; b.toggle(idx(0, 1), WHITE);
  b.stones[idx(1, 1)] = WHITE; b.toggle(idx(1, 1), WHITE);
  b.stones[idx(3, 0)] = BLACK; b.toggle(idx(3, 0), BLACK);
  b.stones[idx(3, 1)] = BLACK; b.toggle(idx(3, 1), BLACK);
  b.stones[idx(2, 1)] = BLACK; b.toggle(idx(2, 1), BLACK);
  b.stones[idx(0, 2)] = BLACK; b.toggle(idx(0, 2), BLACK);
  b.toPlay = BLACK;

  const ana = E.analyzeBoard(b);
  const legal = E.candidateMoves(b, BLACK, ana);
  const stats = ai.evalMovesSync(b, 6.5, legal, 60, 220, 20260921, 14, true);
  const capMove = idx(1, 2);

  const ranked = [...stats.entries()].sort((a, c) => c[1].margin - a[1].margin);
  const rank = ranked.findIndex(([mv]) => mv === capMove);
  ok(stats.has(capMove), '引擎枚举到了提子着法 (1,2)');
  ok(rank < 2, `提子着法排在前两名（第 ${rank + 1} 位）`);
  ok(stats.get(capMove).wr > 0.52, `提子着法胜率 ${(stats.get(capMove).wr * 100).toFixed(1)}%`);

  // 同等条件下，按中级难度选点应落在前两名里（不是随机乱走）
  const level = ai.LEVELS[2];
  const top2 = ranked.slice(0, 2).map(([mv]) => mv);
  let inTop2 = 0, hits = 0;
  for (let i = 0; i < 10; i++) {
    const mv = ai.chooseAiMove(stats, level, rng, legal);
    if (top2.includes(mv)) inTop2++;
    if (mv === capMove) hits++;
  }
  ok(inTop2 >= 6, `按中级难度选点有 ${inTop2}/10 次落在前两名（其中 ${hits} 次正是提子）`);
  console.log(`    候选数 ${legal.length}，提子着法排名 ${rank + 1}`);
}

/* ---------- 11. 行棋方视角（白方回合不许挑对自己不利的一手） ---------- */
section('行棋方视角');
{
  // 11a. 颜色对调的对称局面，混合评估值必须完全相同。
  //      局面 P1：白子在天元，黑先；局面 P2：黑子在天元，白先（两者互为颜色对调）。
  //      引擎对颜色完全对称、贴目取 0 ⇒ 若 margin 以行棋方为基准，两边应相等；
  //      若 margin 仍是黑方视角，两边会互为相反数（正好被这个断言抓住）。
  const p1 = mkBoard([[4, 4, WHITE]], BLACK);
  const p2 = mkBoard([[4, 4, BLACK]], WHITE);
  const legal1 = E.candidateMoves(p1, BLACK, E.analyzeBoard(p1));
  const legal2 = E.candidateMoves(p2, WHITE, E.analyzeBoard(p2));
  const m1 = ai.evalMovesSync(p1, 0, legal1, 40, 160, 555, 12, true);
  const m2 = ai.evalMovesSync(p2, 0, legal2, 40, 160, 555, 12, false);
  let maxDiff = 0, n = 0;
  for (const [mv, a] of m1) {
    const b2 = m2.get(mv);
    if (!b2) continue;
    n++;
    maxDiff = Math.max(maxDiff, Math.abs(a.margin - b2.margin));
  }
  ok(n > 0 && maxDiff < 1e-9,
    `颜色对调局面下 margin 相等（${n} 个候选，最大偏差 ${maxDiff.toExponential(1)}）`);

  // 11b. 选点必须按「对行棋方有利」，而不是按黑方胜率
  //      构造：moveA 黑方胜率 90% 但对白方很不利；moveB 黑方胜率 40% 但白方更划算
  const fake = new Map([
    [idx(0, 0), { wr: 0.90, margin: -5, visits: 100 }],
    [idx(4, 4), { wr: 0.40, margin: +5, visits: 100 }]
  ]);
  const rng2 = ai.makeRng(2024);
  let pickedB = 0;
  for (let i = 0; i < 20; i++) {
    if (ai.chooseAiMove(fake, ai.LEVELS[4], rng2, [idx(0, 0), idx(4, 4)]) === idx(4, 4)) pickedB++;
  }
  ok(pickedB >= 18, `白方回合不挑「黑方胜率最高」的一手（${pickedB}/20 次选了对自己有利的一手）`);

  // 11c. 线位先验是行棋方相对惩罚：不管谁走，一线都是惩罚、三线都是奖励。
  //      （先验只跟落子点有关、不含颜色，所以颜色一换也不该翻转 —— 11a 的对称性断言也覆盖了这点）
  //      第三个参数是「盘面剩余空点数」，第四个是「已走手数」。
  const FULL = 81;
  ok(ai.linePrior(0, 4, FULL, 0) < 0, `一线的先验是惩罚（${ai.linePrior(0, 4, FULL, 0)}）`);
  ok(ai.linePrior(1, 4, FULL, 0) < 0, `二线的先验是惩罚（${ai.linePrior(1, 4, FULL, 0)}）`);
  ok(ai.linePrior(2, 4, FULL, 0) > 0, `三线的先验是奖励（${ai.linePrior(2, 4, FULL, 0)}）`);
  ok(ai.linePrior(3, 4, FULL, 0) > 0, `四线的先验是奖励（${ai.linePrior(3, 4, FULL, 0)}）`);
  ok(ai.linePrior(0, 4, FULL, 0) === ai.linePrior(0, 4, FULL, 0), '线位先验是纯函数（无隐藏状态）');
  ok(ai.linePrior(0, 4, 4, 0) === 0, '盘面快下满后避边先验淡出');
  // 关键回归：中盘（还剩 30 个空点）避边先验必须仍然有效 ——
  // 之前按手数淡出，中盘先验只剩一半，静态项的边缘偏好就把引擎推向边线
  ok(ai.linePrior(0, 4, 30, 40) <= -2.5, `中盘一线的先验仍是满额惩罚（${ai.linePrior(0, 4, 30, 40)}）`);
  ok(ai.linePrior(1, 4, 30, 40) <= -1.25, `中盘二线的先验仍是惩罚（${ai.linePrior(1, 4, 30, 40)}）`);
  // 开局偏好段只管开局：中盘不该再被「三线好」的棋理往内线塞
  ok(ai.linePrior(2, 4, 30, 40) === 0, `中盘三线不再有额外奖励（${ai.linePrior(2, 4, 30, 40)}）`);
}

/* ---------- 12. 引擎不许往边上走 ---------- */
section('引擎选点分布（不许往边上走）');
{
  // 12a. 开局：黑先与白先的最优着法都不应落在一二线
  const emptyB = new Board();
  const emptyW = new Board();
  const lb = E.candidateMoves(emptyB, BLACK, E.analyzeBoard(emptyB));
  const lw = E.candidateMoves(emptyW, WHITE, E.analyzeBoard(emptyW));
  const mb = ai.evalMovesSync(emptyB, 6.5, lb, 40, 160, 31337, 12, true);
  const mw = ai.evalMovesSync(emptyW, 6.5, lw, 40, 160, 31337, 12, false);
  const lineOf = p => Math.min(E.xOf(p), 8 - E.xOf(p), E.yOf(p), 8 - E.yOf(p));
  const topOf = m => {
    let best = -1, bv = -Infinity;
    for (const [mv, v] of m) if (v.margin > bv) { bv = v.margin; best = mv; }
    return best;
  };
  const tb = topOf(mb), tw = topOf(mw);
  ok(lineOf(tb) >= 2, `空盘黑先的最优着法在三四线（(${E.xOf(tb)},${E.yOf(tb)})，线${lineOf(tb)}）`);
  ok(lineOf(tw) >= 2, `空盘白先的最优着法在三四线（(${E.xOf(tw)},${E.yOf(tw)})，线${lineOf(tw)}）`);

  // 12b. 实战：引擎自对弈 16 手，双方都不该下到一线，二线占比要低
  const playGame = (seed, ramp) => {
    ai.setStaticRamp(ramp);
    const rng = ai.makeRng(seed);
    const b = new Board();
    const lines = [];
    for (let m = 0; m < 16; m++) {
      const color = b.toPlay;
      const cands = E.candidateMoves(b, color, E.analyzeBoard(b));
      if (!cands.length) break;
      const st = ai.evalMovesSync(b, 6.5, cands, 30, 120, seed + m * 31, 10, color === BLACK);
      const mv = ai.chooseAiMove(st, ai.LEVELS[4], rng, cands);
      if (mv < 0) break;
      lines.push({ color, line: lineOf(mv) });
      b.play(mv, color);
      b.toPlay = 3 - color;
    }
    ai.setStaticRamp(true);
    return lines;
  };
  const lines = playGame(20260101, true);
  const firstLine = lines.filter(l => l.line === 0).length;
  const secondLine = lines.filter(l => l.line === 1).length;
  const ratio = secondLine / Math.max(1, lines.length);
  ok(firstLine === 0, `自对弈 16 手没有一手下在一线（实际 ${firstLine} 手）`);
  ok(ratio <= 0.25, `自对弈 16 手二线占比 ${(ratio * 100).toFixed(0)}% ≤ 25%`);
  // 分颜色各查一遍：原来的 bug 正是「白方回合被倒置」导致的
  const bFirst = lines.filter(l => l.color === BLACK && l.line === 0).length;
  const wFirst = lines.filter(l => l.color === WHITE && l.line === 0).length;
  ok(bFirst === 0 && wFirst === 0, `黑白双方都没有下在一线（黑 ${bFirst} 手 / 白 ${wFirst} 手）`);
  console.log(`    16 手的线位分布：${JSON.stringify(lines.reduce((m, l) => (m[l.line] = (m[l.line] || 0) + 1, m), {}))}`);

  // 12c. 静态项的「渐入 + 软上限」两个保险丝必须真的在起作用
  const emptyB2 = new Board();
  ok(ai.staticWeightFor(emptyB2) === 0, '空盘时静态项权重为 0（开局 Voronoi 划分无意义）');
  const midB = mkBoard([
    [6, 1, WHITE], [1, 2, WHITE], [2, 2, BLACK], [3, 2, BLACK], [4, 2, WHITE],
    [6, 2, BLACK], [3, 3, WHITE], [6, 3, WHITE], [7, 3, BLACK], [4, 4, BLACK],
    [5, 4, WHITE], [2, 5, BLACK], [6, 5, BLACK], [2, 6, WHITE], [6, 6, WHITE],
    [1, 7, BLACK], [3, 7, BLACK], [4, 7, WHITE], [7, 7, BLACK], [7, 8, WHITE]
  ]);
  ok(ai.staticWeightFor(midB) === 1, '20 子时静态项权重为 1');
  // 软上限：静态增量 40 点时，对 margin 的贡献被压在上限内（否则会盖掉线位先验）
  const rec = { sum: 0, n: 100, stat: 40, sw: 1, prior: 0 };
  const capped = ai.mixValue(rec, 1);
  ai.setStaticCap(0);
  const uncapped = ai.mixValue(rec, 1);
  ai.setStaticCap(3);
  ok(uncapped === 40 && capped < 3.01 && capped > 2.9,
    `静态项被软上限压住（${capped.toFixed(2)}，未限 ${uncapped}）`);
  ok(ai.mixValue({ sum: 0, n: 100, stat: 1, sw: 1, prior: 0 }, 1) > 0.9,
    '正常幅度的静态项几乎不受软上限影响');
}

console.log(`\n———— 结果：${pass} 通过 / ${fail} 失败 ————`);
process.exit(fail ? 1 : 0);
