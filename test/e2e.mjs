/* 端到端测试：真实浏览器里跑完整对局流程
 * 覆盖：落子 → AI 应手 → 胜率曲线更新 → 着法点评 → 悔棋 → 候选着法
 */
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchChrome, CDP } from './cdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8199;
const URL = `http://127.0.0.1:${PORT}/`;
let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

/* 自行拉起静态服务器 */
const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.mjs'), String(PORT)], {
  stdio: 'ignore'
});
await new Promise(r => setTimeout(r, 800));

const { proc } = await launchChrome(9333);
let cdp;
try {
  cdp = await CDP.attach(9333);
  await cdp.goto(URL);
  await new Promise(r => setTimeout(r, 1200));

  /* ---------- 1. 页面加载 ---------- */
  section('页面加载');
  const boot = await cdp.evaluate(`(() => {
    const s = window.GO9App && window.GO9App.state;
    if (!s) return null;
    const cv = document.getElementById('board');
    return {
      ready: true,
      moves: s.moves.length,
      stones: Array.from(s.board.stones).filter(v => v === 1 || v === 2).length,
      canvasW: cv.getBoundingClientRect().width,
      candText: document.getElementById('cand-list').textContent.trim(),
      turn: document.getElementById('turn-text').textContent.trim()
    };
  })()`);
  ok(boot && boot.ready, '应用初始化完成');
  ok(boot.moves === 0 && boot.stones === 0, '开局棋盘为空');
  ok(boot.canvasW > 300, `棋盘尺寸正常（${boot.canvasW}px）`);
  ok(/轮到\s*你/.test(boot.turn), '提示轮到玩家落子', boot.turn);

  /* ---------- 2. 点击落子 ---------- */
  section('落子与 AI 应手');
  // 等开局分析完成（引擎先算好候选着法与胜率）
  await cdp.waitFor(`(() => window.GO9App.state.analysis !== null)()`, 30000).catch(() => 0);
  // 取棋盘上 E5（天元附近）的屏幕坐标（用页面自己的布局参数，避免公式不同步）
  const pt = await cdp.evaluate(`(() => {
    const cv = document.getElementById('board');
    const r = cv.getBoundingClientRect();
    const { margin, cell } = window.UI.L;
    const col = 4, row = 4;                       // E5
    return { x: r.left + margin + col*cell, y: r.top + margin + row*cell };
  })()`);
  await cdp.clickAt(pt.x, pt.y);

  const placed = await cdp.waitFor(`(() => {
    const s = window.GO9App.state;
    const stones = Array.from(s.board.stones).filter(v => v===1||v===2);
    return stones.length >= 1 ? stones.length : 0;
  })()`, 8000).catch(() => 0);
  ok(placed >= 1, `点击后落子成功（盘面 ${placed} 子）`, placed);

  // 等 AI 应手
  const aiMoved = await cdp.waitFor(`(() => {
    const s = window.GO9App.state;
    return s.moves.length >= 2 ? s.moves.length : 0;
  })()`, 60000).catch(() => 0);
  ok(aiMoved >= 2, `AI 完成应手（共 ${aiMoved} 手）`, aiMoved);

  // 等后台分析出结果（胜率曲线与候选着法依赖它）
  await cdp.waitFor(`(() => window.GO9App.state.chart.length >= 1)()`, 30000).catch(() => 0);

  const afterAi = await cdp.evaluate(`(() => {
    const s = window.GO9App.state;
    const stones = Array.from(s.board.stones).filter(v => v===1||v===2);
    return {
      moves: s.moves.length,
      stones: stones.length,
      colors: [...new Set(Array.from(s.board.stones).filter(v=>v===1||v===2))],
      turn: document.getElementById('turn-text').textContent.trim(),
      judge: document.getElementById('judge').textContent.trim(),
      judgeGrade: (document.querySelector('.judge-badge')||{}).textContent || '',
      chartPts: s.chart.length,
      candCount: document.querySelectorAll('#cand-list .cand').length,
      wr: document.getElementById('wr-current').textContent.trim(),
      lead: document.getElementById('wr-lead').textContent.trim(),
      moveList: document.getElementById('move-list').textContent.trim().length
    };
  })()`);
  ok(afterAi.stones === 2, `盘面有 2 子（一黑一白）：${afterAi.stones}`, afterAi.stones);
  ok(afterAi.colors.length === 2, '黑白双方都有棋子');
  ok(afterAi.turn.includes('你'), '回合交还给玩家', afterAi.turn);
  ok(/妙手|好手|普通|俗手|恶手/.test(afterAi.judgeGrade), `给出着法点评：${afterAi.judgeGrade}`, afterAi.judgeGrade);
  ok(afterAi.chartPts >= 1, `胜率曲线已记录 ${afterAi.chartPts} 个数据点`, afterAi.chartPts);
  ok(afterAi.candCount > 0, `候选着法 ${afterAi.candCount} 条`);
  ok(/%/.test(afterAi.wr), `胜率数值显示：${afterAi.wr}`);
  ok(/目/.test(afterAi.lead), `形势目数显示：${afterAi.lead}`);
  ok(afterAi.moveList > 0, '棋谱已记录');

  /* ---------- 3. 再走几手，检查曲线增长 ---------- */
  section('连续对局');
  for (let i = 0; i < 3; i++) {
    // 动态挑一个「空且合法」的点：写死坐标会被 AI 自己占掉，
    // 引擎选点一变，测试就会因为「点空了」而误判失败。
    const p = await cdp.evaluate(`(() => {
      const cv = document.getElementById('board'); const r = cv.getBoundingClientRect();
      const { margin, cell } = window.UI.L;
      const s = window.GO9App.state;
      const E = window.GO9App.E;
      const cand = [[2,2],[6,2],[2,6],[6,6],[6,4],[2,4],[4,6],[4,2],[3,3],[5,5],[0,4],[8,4],[4,0],[4,8],[7,2],[2,7]];
      for (const [col,row] of cand) {
        const idx = (row+1)*11 + (col+1);
        if (s.board.stones[idx] !== 0) continue;
        if (!E.isLegalMove(s.board, idx, s.board.toPlay)) continue;
        return { x: r.left + margin + col*cell, y: r.top + margin + row*cell };
      }
      return null;
    })()`);
    if (!p) continue;
    await cdp.clickAt(p.x, p.y);
    await cdp.waitFor(`(() => { const s = window.GO9App.state; return s.moves.length >= ${(i + 1) * 2 + 2}; })()`, 60000).catch(() => 0);
  }
  const later = await cdp.evaluate(`(() => {
    const s = window.GO9App.state;
    return { moves: s.moves.length, chartPts: s.chart.length, grades: Object.keys(s.grades).length };
  })()`);
  ok(later.moves >= 6, `已进行 ${later.moves} 手`);
  ok(later.chartPts >= 2, `胜率曲线 ${later.chartPts} 个点`);
  ok(later.grades >= 3, `已点评 ${later.grades} 手`);

  /* ---------- 4. 悔棋 ---------- */
  section('悔棋');
  await cdp.evaluate(`document.getElementById('btn-undo').click()`);
  await new Promise(r => setTimeout(r, 1500));
  const undone = await cdp.evaluate(`(() => {
    const s = window.GO9App.state;
    return { moves: s.moves.length, stones: Array.from(s.board.stones).filter(v=>v===1||v===2).length };
  })()`);
  ok(undone.moves < later.moves, `悔棋后手数回退 ${later.moves} → ${undone.moves}`);
  ok(undone.stones === undone.moves, '悔棋后棋盘与棋谱一致');

  /* ---------- 4b. 悔棋后继续下：不能出现非法着法（回归：曾经黑白颠倒导致盘面错乱） ---------- */
  section('悔棋后继续对局');
  const afterUndo = await cdp.evaluate(`(() => {
    const s = window.GO9App.state;
    return { moves: s.moves.length, toPlay: s.board.toPlay, human: s.human };
  })()`);
  ok(afterUndo.toPlay === afterUndo.human, '悔棋后仍然轮到玩家走（黑白没有颠倒）', afterUndo);

  for (let i = 0; i < 3; i++) {
    const p = await cdp.evaluate(`(() => {
      const cv = document.getElementById('board'); const r = cv.getBoundingClientRect();
      const { margin, cell } = window.UI.L;
      const s = window.GO9App.state;
      const cand = [[2,2],[6,6],[0,4],[4,0],[4,8],[8,4],[2,6],[6,2]];
      for (const [col,row] of cand) {
        const p = (row+1)*11 + (col+1);
        if (s.board.stones[p] === 0) return { x: r.left + margin + col*cell, y: r.top + margin + row*cell };
      }
      return null;
    })()`);
    if (!p) break;
    const before = await cdp.evaluate(`window.GO9App.state.moves.length`);
    await cdp.clickAt(p.x, p.y);
    await cdp.waitFor(`(() => window.GO9App.state.moves.length >= ${before + 2})()`, 60000).catch(() => 0);
  }
  const afterUndoPlay = await cdp.evaluate(`(() => {
    const s = window.GO9App.state;
    let dup = 0;
    const seen = new Set();
    for (const m of s.moves) {
      if (m.p < 0) continue;
      if (seen.has(m.p)) dup++;
      seen.add(m.p);
    }
    return { moves: s.moves.length, dup,
             stones: Array.from(s.board.stones).filter(v=>v===1||v===2).length,
             errs: (window.__errs||[]).length };
  })()`);
  ok(afterUndoPlay.dup === 0, '悔棋后继续下没有重复落点', afterUndoPlay);
  ok(afterUndoPlay.stones <= afterUndoPlay.moves, '盘面棋子数不超过棋谱手数（无脱节）', afterUndoPlay);
  ok(afterUndoPlay.errs === 0, '悔棋流程没有抛出未捕获异常', afterUndoPlay);

  /* ---------- 5. 认输 → 结果弹窗；终局计分 ---------- */
  section('终局与计分');
  await cdp.waitFor(`(() => { const s = window.GO9App.state; return !s.busy && !s.over; })()`, 60000).catch(() => 0);
  await cdp.evaluate(`document.getElementById('btn-resign').click()`);
  await new Promise(r => setTimeout(r, 800));
  const ended = await cdp.evaluate(`(() => ({
    over: window.GO9App.state.over,
    modal: !document.getElementById('result').classList.contains('hidden'),
    title: document.getElementById('result-title').textContent,
    body: document.getElementById('result-body').textContent.replace(/\\s+/g,' ').trim()
  }))()`);
  ok(ended.over && ended.modal, '认输后弹出结果', ended);
  if (ended.modal) console.log(`    结果弹窗：${ended.title} — ${ended.body}`);

  const score = await cdp.evaluate(`(() => {
    const s = window.GO9App.state;
    const fs = window.GO9App.AI.finalScore(s.board, s.komi, 60, window.GO9App.AI.makeRng(7));
    return { black: fs.black, white: fs.white, diff: fs.diff,
             stones: Array.from(s.board.stones).filter(v=>v===1||v===2).length };
  })()`);
  ok(typeof score.diff === 'number' && !isNaN(score.diff), `终局计分可用：黑${score.black} 白${score.white} 差${score.diff}`);
  ok(score.black >= score.stones / 2 && score.white >= score.stones / 2, '双方归属点数不少于各自棋子数的一半');

  /* ---------- 6. 控制台无报错 ---------- */
  section('运行时错误');
  const errs = await cdp.evaluate(`(() => (window.__errs||[]).slice())()`);
  ok(errs.length === 0, '页面运行期间未抛出未捕获异常', errs);

} catch (e) {
  fail++;
  console.log('\n测试异常终止: ' + e.message);
} finally {
  try { proc.kill(); } catch (e) { }
  try { server.kill(); } catch (e) { }
}

console.log(`\n———— E2E 结果：${pass} 通过 / ${fail} 失败 ————`);
process.exit(fail ? 1 : 0);
