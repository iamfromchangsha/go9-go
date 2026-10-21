/* ============================================================
 * 九路围棋 · 主流程  —  main.js
 *  对局流程 / AI 回合 / 后台分析 / 胜率曲线 / 着法点评
 * ============================================================ */
(function (global) {
  'use strict';

  const E = global.GO9.engine;
  const AI = global.GO9.ai;
  const { Board, idx, xOf, yOf, BLACK, WHITE, EMPTY } = E;
  const $ = id => document.getElementById(id);

  const state = {
    board: null,
    komi: 6.5,
    level: AI.LEVELS[2],
    human: BLACK,
    moves: [],        // {num, color:'B'|'W', p(-1 表示停一手)}
    grades: {},       // 手数 → 点评
    chart: [],        // {move, wr, who}
    analysis: null,   // 最近一次分析结果
    analysisMove: -1, // 分析对应的手数（用于判断分析是否对应当前局面）
    over: false,
    busy: false,
    seedCounter: 1,
    rng: AI.makeRng((Date.now() ^ (Math.random() * 1e9)) >>> 0)
  };
  let epoch = 0;      // 异步任务代号：新局/悔棋时自增，令旧结果失效

  /* ========================= 工具 ========================= */
  function colorChar(c) { return c === BLACK ? 'B' : 'W'; }

  function numMap() {
    const m = new Map();
    for (const mv of state.moves) if (mv.p >= 0) m.set(mv.p, mv.num);
    return m;
  }

  function rebuildBoard(moves) {
    const b = new Board();
    b.hist = new Map();
    b.trackSuperko = true;
    b.hist.set(b.hash(), true);
    for (const mv of moves) {
      const c = mv.color === 'B' ? BLACK : WHITE;
      if (mv.p < 0) { b.passTurn(); b.toPlay = 3 - c; continue; }
      b.play(mv.p, c);
      b.toPlay = 3 - c;      // 注意：下一手是对手，不是刚走完的这一方
    }
    state.board = b;
    return b;
  }

  /** 把「黑方胜率」换算成玩家视角的胜率（点评面板统一显示玩家自己的胜率） */
  function humanWR(blackWR) { return state.human === BLACK ? blackWR : 1 - blackWR; }

  function currentJudgeView() {
    // 组合「玩家上一手的点评」与「AI 上一手的点评」
    const nums = Object.keys(state.grades).map(Number).sort((a, b) => b - a);
    if (!nums.length) return pendingJudgeView('还没有可点评的着法');
    const lastNum = nums[0];
    const g = state.grades[lastNum];
    const mv = state.moves.find(m => m.num === lastNum);
    const isHuman = mv && mv.color === colorChar(state.human);
    if (isHuman) {
      return { grade: g.grade, note: g.note, delta: g.delta,
               playedWR: humanWR(g.playedWR), bestMove: g.bestMove, band: g.band };
    }
    // 最后一手是 AI 的：展示玩家上一手的点评，并附上 AI 这一手的评价
    const humanNums = nums.filter(n => {
      const m = state.moves.find(x => x.num === n);
      return m && m.color === colorChar(state.human);
    });
    if (!humanNums.length) {
      // 玩家这一手还没点评（引擎当时在分析）—— 先展示 AI 的评价
      return { grade: g.grade, note: g.note, delta: g.delta, playedWR: humanWR(g.playedWR),
               bestMove: g.bestMove, band: g.band, aiOnly: true };
    }
    const hg = state.grades[humanNums[0]];
    return { grade: hg.grade, note: hg.note, delta: hg.delta,
             playedWR: humanWR(hg.playedWR), bestMove: hg.bestMove, band: hg.band,
             aiNote: AI.GRADES[g.grade].name, aiColor: AI.GRADES[g.grade].color };
  }

  /** 分析未就绪时的占位提示 */
  function pendingJudgeView(text) {
    return { pending: true, note: text };
  }

  /* ========================= 开局 ========================= */
  function newGame() {
    epoch++;
    state.board = new Board();
    state.board.hist = new Map();
    state.board.trackSuperko = true;
    state.board.hist.set(state.board.hash(), true);
    state.moves = [];
    state.grades = {};
    state.pendingGrade = null;
    state.chart = [];
    state.analysis = null;
    state.analysisMove = -1;
    state.over = false;
    state.busy = false;
    state.rng = AI.makeRng((Date.now() ^ (Math.random() * 1e9)) >>> 0);

    UI.hideResult();
    UI.setView({ stones: state.board.stones, lastMove: -1, moveNumbers: new Map(),
                 hover: -1, hint: -1, dead: null });
    UI.renderMoves([], {});
    UI.renderJudge(null);
    UI.renderCandidates([], -1, -1, '引擎分析');
    UI.drawChart([]);
    $('wr-current').textContent = '--';
    $('wr-lead').textContent = '形势 --';
    updateTurnUI();

    if (state.human === WHITE) setTimeout(aiTurn, 250);
    else startAnalysis(epoch);      // 开局就先分析，供第一手点评与候选着法
  }

  function updateTurnUI() {
    if (state.over) return;
    const b = state.board;
    if (b.toPlay === state.human) {
      const ana = E.analyzeBoard(b);
      const legal = E.candidateMoves(b, state.human, ana);
      if (!legal.length) {
        UI.setTurn(colorChar(state.human) === 'B' ? 'black' : 'white',
          '棋盘已下满，点<b>停一手</b>结束对局');
      } else {
        UI.setTurn(colorChar(state.human) === 'B' ? 'black' : 'white', '轮到 <b>你</b> 落子');
      }
      UI.setThinking(false);
    } else {
      UI.setTurn(colorChar(b.toPlay) === 'B' ? 'black' : 'white', 'AI 思考中…');
      UI.setThinking(true, 'AI 思考中', 0);
    }
  }

  /* ========================= 玩家落子 ========================= */
  async function humanMove(p) {
    if (state.busy || state.over) return;
    const b = state.board;
    if (b.toPlay !== state.human) return;
    if (!E.isLegalMove(b, p, state.human)) { UI.toast('这里不能落子'); return; }

    const color = b.toPlay;
    const preBoard = b.clone();          // 留一份「落子前」的局面，供补评估用
    if (!b.play(p, color)) { UI.toast('这一手无法成立'); return; }
    b.toPlay = 3 - color;
    const num = state.moves.length + 1;
    state.moves.push({ num, color: colorChar(color), p });

    // 点评：用「落子前」的分析结果
    let g = gradeAgainstAnalysis(p, color);
    if (!g && state.analysis && state.analysisMove === state.moves.length - 1) {
      // 这一手没进候选表 → 单独补评估（沿用同一随机序列）
      await ensureMoveEvaluated(state.analysis, p, preBoard);
      g = gradeAgainstAnalysis(p, color);
    }
    if (g) state.grades[num] = g;
    else state.pendingGrade = { num, color, p, analysisMove: state.moves.length - 1 };

    UI.setView({ stones: b.stones, lastMove: p, moveNumbers: numMap() });
    UI.renderMoves(state.moves, state.grades);
    UI.renderJudge(g ? currentJudgeView() : pendingJudgeView('这一手落子时引擎还在分析，稍后会补上点评'));
    if (g) {
      const info = AI.GRADES[g.grade];
      UI.toast(`${info.name} · ${g.note}`);
    }
    aiTurn();
  }

  /** 用当前分析（必须是落子前的局面）给玩家这一手定性 */
  function gradeAgainstAnalysis(p, color) {
    const an = state.analysis;
    if (!an || state.analysisMove !== state.moves.length - 1) return null;
    if (!an.stats.size) return null;
    if (!an.stats.has(p)) return null;      // 这一手没进候选表，需要单独评估
    return AI.gradeMove(an.stats, p, color === BLACK, an.bestMove, an.bestWR, an.band, an.bestMargin);
  }

  /**
   * 若玩家这一手没被评估覆盖，单独评估它（沿用同一随机序列，保证可比）。
   * 注意要评估的是「落子前」的局面。
   */
  async function ensureMoveEvaluated(an, p, preBoard) {
    if (an.stats.has(p)) return an.stats;
    const board = preBoard || boardBefore(state.moves.length);
    const seed = an.seed >>> 0;
    // 补评估的是玩家这一手，行棋方＝玩家
    const extra = await AI.evalMovesAsync(board, state.komi, [p],
      AI.EVAL_COARSE[state.level.key] || 60, AI.EVAL_FINE[state.level.key] || 220,
      seed, null, 1, state.human === BLACK);
    for (const [k, v] of extra) an.stats.set(k, v);
    return an.stats;
  }

  /** 重放出「前 n 手」之后的局面 */
  function boardBefore(n) {
    const b = new Board();
    b.hist = new Map();
    b.trackSuperko = true;
    b.hist.set(b.hash(), true);
    for (const mv of state.moves.slice(0, n)) {
      const c = mv.color === 'B' ? BLACK : WHITE;
      if (mv.p < 0) { b.passTurn(); b.toPlay = 3 - c; continue; }
      b.play(mv.p, c);
      b.toPlay = 3 - c;      // 注意：下一手是对手，不是刚走完的这一方
    }
    return b;
  }

  /* ========================= AI 回合 ========================= */
  async function aiTurn() {
    if (state.over) return;
    const myEpoch = epoch;
    state.busy = true;
    updateTurnUI();

    const b = state.board;
    const aiColor = b.toPlay;

    // 用与展示完全相同的评估管线：引擎推荐什么，它就走什么
    const analysis = await runAnalysis(myEpoch, 'AI 思考中');
    if (!analysis || myEpoch !== epoch) return;
    if (state.over) return;

    let mv = AI.chooseAiMove(analysis.stats, state.level, state.rng, analysis.legal);
    // 局面评估值也记入胜率曲线（玩家这一手之后的形势）
    pushChartPoint(state.moves.length, analysis.winRate);
    // 引擎候选来自近似合法性，落子前精确校验，非法则换次优着法
    if (mv >= 0 && !E.isLegalMove(b, mv, aiColor)) {
      const alts = [...analysis.stats.entries()]
        .filter(([m, inf]) => inf && inf.visits > 0 && m !== mv)
        .sort((x, y) => y[1].wr - x[1].wr);
      mv = -1;
      for (const [m] of alts) {
        if (E.isLegalMove(b, m, aiColor)) { mv = m; break; }
      }
    }
    if (mv < 0) {
      b.passTurn();
      state.moves.push({ num: state.moves.length + 1, color: colorChar(aiColor), p: -1 });
      UI.toast('AI 停一手');
    } else {
      if (!b.play(mv, aiColor)) { UI.toast('AI 重新选择'); state.busy = false; return; }
      b.toPlay = 3 - aiColor;
      const num = state.moves.length + 1;
      state.moves.push({ num, color: colorChar(aiColor), p: mv });

      // AI 这一手的点评（与它自己的评估口径一致）
      const g = AI.gradeMove(analysis.stats, mv, aiColor === BLACK, analysis.bestMove, analysis.bestWR, analysis.band, analysis.bestMargin);
      if (g) {
        // AI 走的就是引擎最优着法，不该标成「妙手」，封顶为「好手」
        if (g.grade === 'brilliant') { g.grade = 'good'; g.note = '这一手就是引擎的最优选择'; }
        state.grades[num] = g;
      }

      UI.setView({ stones: b.stones, lastMove: mv, moveNumbers: numMap() });
      UI.renderMoves(state.moves, state.grades);
      UI.renderJudge(currentJudgeView());
    }

    state.busy = false;

    if (b.passes >= 2) { endGame(); return; }
    if (state.moves.length >= 200) { endGame(); return; }

    updateTurnUI();
    startAnalysis(myEpoch);
  }

  /* ==================== 分析（配对模拟评估） ==================== */
  /**
   * 评估当前局面：给每个合法着法打分，并给出局面自身的胜率。
   * 候选着法共用同一随机序列（配对模拟），着法之间的细微差距才分得清。
   */
  async function runAnalysis(myEpoch, label) {
    const ep = myEpoch === undefined ? epoch : myEpoch;
    const board = state.board;
    const level = state.level;
    const coarse = AI.EVAL_COARSE[level.key] || 100;
    const fine = AI.EVAL_FINE[level.key] || 320;
    const ana = E.analyzeBoard(board);
    const legal = E.candidateMoves(board, board.toPlay, ana);
    const seed = (state.seedCounter = (state.seedCounter + 1) >>> 0);
    UI.setThinking(true, label || '分析中', 0);

    const stats = await AI.evalMovesAsync(board, state.komi, legal, coarse, fine, seed,
      (r, out) => {
        if (ep !== epoch) return;
        UI.setThinking(true, label || '分析中', r);
        const cands = topCandidates(out, board.toPlay === BLACK);
        UI.renderCandidates(cands, bestOf(out), -1, '引擎分析');
      }, AI.EVAL_REFINE[level.key] || 14, board.toPlay === BLACK);
    if (ep !== epoch) return null;

    const best = bestOf(stats);
    const posSims = AI.EVAL_POSITION[level.key] || 400;
    const pos = await AI.evalPositionAsync(board, state.komi, posSims, (seed ^ 0x9e3779b9) >>> 0, r => {
      if (ep !== epoch) return;
      UI.setThinking(true, label || '分析中', 0.9 + r * 0.1);
    });
    if (ep !== epoch) return null;

    return { stats, bestMove: best.move, bestWR: best.wr, bestMargin: best.margin, winRate: pos.winRate,
             margin: pos.margin, legal, seed, band: AI.noiseBandOf(fine) };
  }

  /** 引擎最优着法：按「混合评估值」挑（噪声小、区分度高），胜率单独显示 */
  function bestOf(stats) {
    let best = { move: -1, wr: -1, margin: -1e9 };
    for (const [mv, inf] of stats) {
      if (inf && inf.margin > best.margin) best = { move: mv, wr: inf.wr, margin: inf.margin };
    }
    return best;
  }

  /* ========================= 后台分析 ========================= */
  async function startAnalysis(myEpoch) {
    const ep = myEpoch === undefined ? epoch : myEpoch;
    const moveNo = state.moves.length;
    const analysis = await runAnalysis(ep, '分析中');
    if (!analysis || ep !== epoch) return;

    // 可能存在并发分析（旧的比新的先完成），只保留较新的结果
    if (moveNo >= state.analysisMove) {
      state.analysis = analysis;
      state.analysisMove = moveNo;
    }
    // 玩家抢在分析完成前落子 → 这里补评
    if (state.pendingGrade && state.pendingGrade.analysisMove === moveNo) {
      const pg = state.pendingGrade;
      state.pendingGrade = null;
      await ensureMoveEvaluated(analysis, pg.p, boardBefore(pg.num - 1));
      const g = AI.gradeMove(analysis.stats, pg.p, pg.color === BLACK,
        analysis.bestMove, analysis.bestWR, analysis.band);
      if (g) {
        state.grades[pg.num] = g;
        UI.renderMoves(state.moves, state.grades);
        UI.renderJudge(currentJudgeView());
        UI.toast(`${AI.GRADES[g.grade].name} · ${g.note}`);
      }
    }

    // 胜率曲线
    pushChartPoint(moveNo, analysis.winRate);
    updateWinRateUI(analysis);

    const cands = topCandidates(analysis.stats, state.board.toPlay === BLACK);
    UI.renderCandidates(cands, analysis.bestMove, -1, '引擎分析');
    UI.setThinking(false);
  }

  /** 在胜率曲线上记录一个点（曲线显示的是「玩家视角」的胜率，who = 刚刚落子的一方） */
  function pushChartPoint(moveNo, wr) {
    const who = colorChar(3 - state.board.toPlay);
    const humanWR = state.human === BLACK ? wr : 1 - wr;
    const last = state.chart[state.chart.length - 1];
    if (last && last.move === moveNo) { last.wr = humanWR; }
    else state.chart.push({ move: moveNo, wr: humanWR, who });
    UI.drawChart(state.chart);
  }

  /** 候选列表：按「对行棋方的有利程度」排序（margin），并把胜率换算成行棋方视角 */
  function topCandidates(stats, moverIsBlack) {
    const mover = moverIsBlack === undefined ? state.board.toPlay === BLACK : moverIsBlack;
    return [...stats.entries()]
      .map(([move, info]) => ({
        move, wr: info.wr, visits: info.visits, margin: info.margin,
        moverWR: mover ? info.wr : 1 - info.wr
      }))
      .sort((a, b) => b.margin - a.margin)
      .slice(0, 6);
  }

  function updateWinRateUI(analysis) {
    const blackWR = analysis.winRate;
    const humanWR = state.human === BLACK ? blackWR : 1 - blackWR;
    $('wr-current').textContent = (humanWR * 100).toFixed(1) + '%';
    const lead = AI.estimateLead(blackWR, state.komi);
    const mine = state.human === BLACK ? lead : -lead;
    const who = state.human === BLACK ? '黑' : '白';
    $('wr-lead').textContent = '形势 ' + who + (mine >= 0 ? '+' : '') + mine.toFixed(1) + ' 目';
  }

  /* ========================= 终局 ========================= */
  function endGame() {
    if (state.over) return;
    state.over = true;
    state.busy = false;
    UI.setThinking(false);
    UI.setTurn('black', '对局结束');
    const fs = AI.finalScore(state.board, state.komi, 300, state.rng);
    UI.setView({ dead: fs.dead });
    const blackWin = fs.diff > 0;
    const humanWin = (state.human === BLACK) === blackWin;
    const winner = blackWin ? '黑' : '白';
    const margin = Math.abs(fs.diff);
    const html =
      `<span class="big">${humanWin ? '你赢了' : '你输了'}</span>` +
      `${winner}胜 ${margin.toFixed(1)} 目（贴目 ${state.komi}）<br>` +
      `黑 ${fs.black} 目 · 白 ${fs.white} 目<br>` +
      `<span style="color:var(--text-mute)">共 ${state.moves.length} 手 · 难度 ${state.level.name}</span>`;
    UI.showResult(humanWin ? '胜' : '负', html);
  }

  /* ========================= 悔棋 ========================= */
  function undo() {
    if (state.busy || !state.moves.length) return;
    epoch++;
    state.busy = false;
    // 退回到轮到玩家落子
    while (state.moves.length) {
      const last = state.moves[state.moves.length - 1];
      state.moves.pop();
      if (last.color === colorChar(state.human)) break;
      if (!state.moves.length) { state.moves.push(last); break; }
    }
    state.grades = {};
    for (const mv of state.moves) { /* 重新点评留到分析完成后 */ }
    state.analysis = null;
    state.analysisMove = -1;
    const b = rebuildBoard(state.moves);
    UI.setView({ stones: b.stones, lastMove: b.lastMove, moveNumbers: numMap(), hint: -1, dead: null });
    UI.renderMoves(state.moves, state.grades);
    UI.renderJudge(null);
    UI.renderCandidates([], -1, -1, '引擎分析');
    updateTurnUI();
    startAnalysis(epoch);
  }

  /* ========================= 交互绑定 ========================= */
  function bind() {
    // 难度
    const sel = $('sel-level');
    AI.LEVELS.forEach((lv, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = `${lv.name} · ${lv.desc}`;
      sel.appendChild(o);
    });
    sel.value = String(AI.LEVELS.indexOf(state.level));
    sel.addEventListener('change', () => {
      state.level = AI.LEVELS[Number(sel.value)];
      UI.toast('难度：' + state.level.name + '（下一手生效）');
    });

    $('sel-komi').addEventListener('change', e => {
      state.komi = Number(e.target.value);
      newGame();
    });
    $('sel-side').addEventListener('change', e => {
      state.human = e.target.value === 'black' ? BLACK : WHITE;
      newGame();
    });
    $('btn-new').addEventListener('click', newGame);
    $('btn-result-new').addEventListener('click', newGame);
    $('btn-undo').addEventListener('click', undo);

    $('btn-hint').addEventListener('click', () => {
      const an = state.analysis;
      if (!an || an.bestMove < 0) { UI.toast('引擎还在分析，请稍候'); return; }
      UI.toast('建议着法：' + UI.coordText(an.bestMove));
      UI.setView({ hint: an.bestMove });
    });

    $('btn-pass').addEventListener('click', () => {
      if (state.busy || state.over) return;
      const b = state.board;
      if (b.toPlay !== state.human) return;
      b.passTurn();
      state.moves.push({ num: state.moves.length + 1, color: colorChar(state.human), p: -1 });
      UI.renderMoves(state.moves, state.grades);
      if (b.passes >= 2) { endGame(); return; }
      aiTurn();
    });

    $('btn-resign').addEventListener('click', () => {
      if (state.over) return;
      state.over = true;
      state.busy = false;
      UI.setThinking(false);
      UI.setTurn('black', '你认输了');
      UI.showResult('负', `<span class="big">你输了</span>第 ${state.moves.length} 手认输`);
    });

    $('chk-numbers').addEventListener('change', e => {
      UI.setView({ moveNumbers: e.target.checked ? numMap() : new Map() });
    });

    $('btn-sgf').addEventListener('click', async () => {
      const sgf = buildSGF();
      try {
        await navigator.clipboard.writeText(sgf);
        UI.toast('SGF 已复制到剪贴板');
      } catch (err) {
        UI.toast('复制失败，请检查浏览器权限');
      }
    });

    // 棋盘交互
    const cv = $('board');
    cv.addEventListener('click', ev => {
      const p = UI.pointFromEvent(ev);
      if (p >= 0) humanMove(p);
    });
    cv.addEventListener('mousemove', ev => {
      const p = UI.pointFromEvent(ev);
      if (p !== UI.view.hover) {
        UI.view.hover = p;
        UI.redraw();
      }
    });
    cv.addEventListener('mouseleave', () => {
      UI.view.hover = -1;
      UI.redraw();
    });

    UI.setHoverHandler(p => {
      UI.view.hover = p;
      UI.redraw();
    });

    window.addEventListener('resize', () => {
      UI.layoutBoard();
      UI.layoutChart();
      UI.redraw();
      UI.drawChart(state.chart);
    });
  }

  function buildSGF() {
    // 9 路棋盘的列名要跳过 I：A B C D E F G H J（9 列）
    const COLS = 'abcdefghj';
    const ROWS = 'abcdefghi';               // a 是最上面一行
    let sgf = `(;GM[1]FF[4]SZ[9]KM[${state.komi}]RU[Chinese]PB[${state.human === BLACK ? '人类' : 'AI'}]PW[${state.human === BLACK ? 'AI' : '人类'}]`;
    for (const mv of state.moves) {
      if (mv.p < 0) { sgf += '[]'; continue; }        // 停一手
      const x = xOf(mv.p), y = yOf(mv.p);
      sgf += `[${COLS[x]}${ROWS[8 - y]}]`;
    }
    return sgf + ')';
  }

  /* ========================= 启动 ========================= */
  const BUILD = '2026-10-21d';

  function boot() {
    UI.layoutBoard();
    UI.layoutChart();
    bind();
    const verEl = document.getElementById('ver');
    if (verEl) verEl.textContent = BUILD;
    newGame();
    // 暴露给自动化测试 / 调试
    global.GO9App = { state, newGame, humanMove, undo, startAnalysis, AI, E };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
