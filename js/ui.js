/* ============================================================
 * 九路围棋 · 界面渲染  —  ui.js
 *  棋盘绘制 / 胜率曲线 / 候选着法 / 点评 / 棋谱
 * ============================================================ */
(function (global) {
  'use strict';

  const E = global.GO9.engine;
  const AI = global.GO9.ai;
  const VALUE_SIGMA = 16;
  const { N, idx, xOf, yOf, BLACK, WHITE, EMPTY } = E;

  /* 棋盘坐标：列 A B C D E F G H J（沿用围棋惯例跳过 I），行 1-9 自下而上 */
  const COLS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J'];
  function coordText(p) { return COLS[xOf(p)] + (N - yOf(p)); }

  /* ------------------------- 棋盘 ------------------------- */
  const boardCv = document.getElementById('board');
  const bctx = boardCv.getContext('2d');
  let L = { size: 0, margin: 32, cell: 0 };
  let view = { stones: null, lastMove: -1, moveNumbers: null, hover: -1, hint: -1 };

  function layoutBoard() {
    // 棋盘尺寸由视口推算（而不是容器宽度），避免与 grid 的 auto 列宽互相依赖
    const wide = (window.innerWidth || 1200) >= 980;
    const reserved = wide ? 372 + 20 + 40 : 40;      // 右栏 + 间距 + 页面内边距
    const availW = Math.max(260, (window.innerWidth || 1200) - reserved);
    const availH = Math.max(260, (window.innerHeight || 800) - 250);
    const cssW = Math.round(Math.min(availW, availH, 560));
    const cssH = cssW;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    boardCv.style.width = cssW + 'px';
    boardCv.style.height = cssH + 'px';
    boardCv.width = Math.round(cssW * dpr);
    boardCv.height = Math.round(cssH * dpr);
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // 边距要放得下坐标标注，且不被角落的棋子压住：
    // margin ≥ 棋子半径 + 标注高度
    const margin = Math.round((0.0575 * cssW + 15) / 1.115);
    // 注意：就地修改 L，不要重新赋值 —— 外部（测试/调试）持有的是同一个对象引用
    L.size = cssW;
    L.margin = margin;
    L.cell = (cssW - margin * 2) / (N - 1);
  }

  function px(col) { return L.margin + col * L.cell; }
  function py(row) { return L.margin + row * L.cell; }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawStone(ctx, cx, cy, r, color, num) {
    const g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.15, cx, cy, r);
    if (color === BLACK) {
      g.addColorStop(0, '#4a505c');
      g.addColorStop(0.45, '#22262e');
      g.addColorStop(1, '#0c0e12');
    } else {
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.5, '#f2efe6');
      g.addColorStop(1, '#cfc9ba');
    }
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.35)';
    ctx.shadowBlur = r * 0.5;
    ctx.shadowOffsetY = r * 0.16;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();
    if (num) {
      ctx.fillStyle = color === BLACK ? '#f0c470' : '#2a2f38';
      ctx.font = `600 ${Math.round(r * 0.82)}px ui-monospace, Consolas, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(num), cx, cy + r * 0.04);
    }
  }

  function drawBoard() {
    const ctx = bctx;
    const { size, margin, cell } = L;
    ctx.clearRect(0, 0, size, size);

    // 棋盘底
    const bg = ctx.createLinearGradient(0, 0, size, size);
    bg.addColorStop(0, '#e7bd78');
    bg.addColorStop(0.5, '#dfaf66');
    bg.addColorStop(1, '#d5a45b');
    ctx.save();
    roundRect(ctx, 0, 0, size, size, 10);
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.clip();
    // 木纹
    ctx.globalAlpha = 0.05;
    ctx.strokeStyle = '#7a5a2c';
    ctx.lineWidth = 1;
    for (let i = 0; i < 26; i++) {
      const yy = (i * 37) % size;
      ctx.beginPath();
      ctx.moveTo(0, yy);
      ctx.bezierCurveTo(size * 0.3, yy + 6, size * 0.7, yy - 6, size, yy + 2);
      ctx.stroke();
    }
    ctx.restore();

    // 棋盘线
    ctx.strokeStyle = 'rgba(60,44,22,.88)';
    ctx.lineWidth = Math.max(1, size / 700);
    ctx.beginPath();
    for (let i = 0; i < N; i++) {
      ctx.moveTo(px(0), py(i)); ctx.lineTo(px(N - 1), py(i));
      ctx.moveTo(px(i), py(0)); ctx.lineTo(px(i), py(N - 1));
    }
    ctx.stroke();

    // 外框加粗
    ctx.strokeStyle = 'rgba(50,36,16,.95)';
    ctx.lineWidth = Math.max(1.6, size / 460);
    ctx.strokeRect(px(0), py(0), (N - 1) * cell, (N - 1) * cell);

    // 星位
    ctx.fillStyle = 'rgba(50,36,16,.9)';
    const stars = [[2, 2], [6, 2], [2, 6], [6, 6], [4, 4]];
    for (const [c, r] of stars) {
      ctx.beginPath();
      ctx.arc(px(c), py(r), Math.max(2.4, cell * 0.085), 0, Math.PI * 2);
      ctx.fill();
    }

    // 坐标
    ctx.fillStyle = 'rgba(60,44,22,.72)';
    ctx.font = `${Math.round(Math.max(10, size / 42))}px ui-monospace, Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < N; i++) {
      ctx.fillText(COLS[i], px(i), margin / 2 + 2);          // 列标（顶部）
      ctx.fillText(String(N - i), margin / 2, py(i));       // 行标（左侧）
    }

    // 提示标记（只有点「提示」时才出现，不会随分析刷新闪动）
    if (view.hint >= 0 && view.stones && view.stones[view.hint] === EMPTY) {
      const cx = px(xOf(view.hint)), cy = py(yOf(view.hint));
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, cell * 0.34, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(232,180,81,.95)';
      ctx.lineWidth = Math.max(2, cell * 0.06);
      ctx.stroke();
      ctx.setLineDash([cell * 0.1, cell * 0.08]);
      ctx.beginPath();
      ctx.arc(cx, cy, cell * 0.46, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(232,180,81,.75)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
    }

    // 棋子
    const stones = view.stones;
    if (stones) {
      const r = cell * 0.46;
      for (let p = 0; p < stones.length; p++) {
        const s = stones[p];
        if (s !== BLACK && s !== WHITE) continue;
        const num = view.moveNumbers ? view.moveNumbers.get(p) : null;
        drawStone(ctx, px(xOf(p)), py(yOf(p)), r, s, num);
      }
      // 最后一手标记
      if (view.lastMove >= 0) {
        const cx = px(xOf(view.lastMove)), cy = py(yOf(view.lastMove));
        const s = stones[view.lastMove];
        ctx.beginPath();
        ctx.arc(cx, cy, cell * 0.17, 0, Math.PI * 2);
        ctx.fillStyle = s === BLACK ? '#f0c470' : '#22262e';
        ctx.fill();
      }
      // 死子标记
      if (view.dead) {
        ctx.strokeStyle = 'rgba(226,86,79,.95)';
        ctx.lineWidth = 2;
        for (let p = 0; p < stones.length; p++) {
          if (!view.dead[p]) continue;
          const cx = px(xOf(p)), cy = py(yOf(p)), d = cell * 0.22;
          ctx.beginPath();
          ctx.moveTo(cx - d, cy - d); ctx.lineTo(cx + d, cy + d);
          ctx.moveTo(cx + d, cy - d); ctx.lineTo(cx - d, cy + d);
          ctx.stroke();
        }
      }
    }

    // 悬停预览
    if (view.hover >= 0 && view.stones && view.stones[view.hover] === EMPTY) {
      const cx = px(xOf(view.hover)), cy = py(yOf(view.hover));
      ctx.beginPath();
      ctx.arc(cx, cy, cell * 0.46, 0, Math.PI * 2);
      ctx.fillStyle = view.hoverColor || 'rgba(20,24,30,.35)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.35)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
  }

  /** 画布坐标 → 棋盘点 */
  function pointFromEvent(ev) {
    const rect = boardCv.getBoundingClientRect();
    const cx = (ev.clientX - rect.left) * (L.size / rect.width);
    const cy = (ev.clientY - rect.top) * (L.size / rect.height);
    const col = Math.round((cx - L.margin) / L.cell);
    const row = Math.round((cy - L.margin) / L.cell);
    if (col < 0 || row < 0 || col >= N || row >= N) return -1;
    return idx(col, row);
  }

  /* ------------------------- 胜率曲线 ------------------------- */
  const chartCv = document.getElementById('chart');
  const cctx = chartCv.getContext('2d');

  function layoutChart() {
    const cssW = chartCv.parentElement.clientWidth;
    const cssH = 148;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    chartCv.style.width = cssW + 'px';
    chartCv.style.height = cssH + 'px';
    chartCv.width = Math.round(cssW * dpr);
    chartCv.height = Math.round(cssH * dpr);
    cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawChart(points) {
    const ctx = cctx;
    const w = chartCv.clientWidth, h = chartCv.clientHeight;
    ctx.clearRect(0, 0, w, h);
    const padL = 26, padR = 6, padT = 8, padB = 16;
    const iw = w - padL - padR, ih = h - padT - padB;

    // 网格
    ctx.strokeStyle = 'rgba(255,255,255,.07)';
    ctx.lineWidth = 1;
    ctx.font = '9px ui-monospace, Consolas, monospace';
    ctx.fillStyle = 'rgba(230,236,243,.38)';
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const v of [0, 25, 50, 75, 100]) {
      const y = padT + ih * (1 - v / 100);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      if (v === 0 || v === 50 || v === 100) ctx.fillText(String(v), padL - 4, y);
    }
    // 50% 参考线
    ctx.strokeStyle = 'rgba(255,255,255,.26)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(padL, padT + ih / 2); ctx.lineTo(w - padR, padT + ih / 2);
    ctx.stroke();
    ctx.setLineDash([]);

    if (!points || points.length === 0) {
      ctx.fillStyle = 'rgba(230,236,243,.3)';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '11px sans-serif';
      ctx.fillText('暂无数据', padL + iw / 2, padT + ih / 2);
      return;
    }

    const maxMove = Math.max(10, points[points.length - 1].move);
    const X = m => padL + (m / maxMove) * iw;
    const Y = wr => padT + ih * (1 - wr);

    // 曲线下方填充（黑方优势区）
    ctx.beginPath();
    ctx.moveTo(X(points[0].move), padT + ih);
    for (const p of points) ctx.lineTo(X(p.move), Y(p.wr));
    ctx.lineTo(X(points[points.length - 1].move), padT + ih);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, padT, 0, padT + ih);
    grad.addColorStop(0, 'rgba(120,140,170,.30)');
    grad.addColorStop(0.5, 'rgba(120,140,170,.10)');
    grad.addColorStop(1, 'rgba(120,140,170,.26)');
    ctx.fillStyle = grad;
    ctx.fill();

    // 曲线
    ctx.beginPath();
    points.forEach((p, i) => {
      const x = X(p.move), y = Y(p.wr);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#e8b451';
    ctx.lineWidth = 1.8;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // 数据点
    for (const p of points) {
      const x = X(p.move), y = Y(p.wr);
      ctx.beginPath();
      ctx.arc(x, y, p.who === 'B' ? 3.4 : 2.8, 0, Math.PI * 2);
      ctx.fillStyle = p.who === 'B' ? '#e8b451' : '#5aa9ff';
      ctx.fill();
      if (p.who === 'B') {
        ctx.strokeStyle = 'rgba(232,180,81,.35)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // x 轴刻度
    ctx.fillStyle = 'rgba(230,236,243,.34)';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.font = '9px ui-monospace, Consolas, monospace';
    ctx.fillText('第1手', padL, padT + ih + 3);
    ctx.textAlign = 'right';
    ctx.fillText('第' + maxMove + '手', w - padR, padT + ih + 3);
  }

  /* ------------------------- 面板 ------------------------- */
  const $ = id => document.getElementById(id);

  function renderCandidates(list, bestMove, playedMove, whoText) {
    const ul = $('cand-list');
    $('cand-who').textContent = whoText || '引擎分析';
    if (!list || !list.length) {
      ul.innerHTML = '<li class="empty">等待分析…</li>';
      return;
    }
    ul.innerHTML = '';
    list.slice(0, 6).forEach((c, i) => {
      const li = document.createElement('li');
      li.className = 'cand' + (c.move === bestMove ? ' is-best' : '') + (c.move === playedMove ? ' is-played' : '');
      const wr = Math.round(c.wr * 100);
      li.innerHTML =
        `<span class="coord">${coordText(c.move)}${c.move === bestMove ? '<b class="star">★</b>' : ''}</span>` +
        `<span class="bar"><i style="width:${wr}%"></i></span>` +
        `<span class="cand-val">${wr}%</span>`;
      li.title = `黑方胜率 ${wr}%（访问 ${c.visits} 次）`;
      li.addEventListener('mouseenter', () => hoverCallback && hoverCallback(c.move));
      li.addEventListener('mouseleave', () => hoverCallback && hoverCallback(-1));
      ul.appendChild(li);
    });
  }

  let hoverCallback = null;
  function setHoverHandler(fn) { hoverCallback = fn; }

  function renderJudge(d) {
    const box = $('judge');
    if (!d) {
      box.innerHTML = '<div class="judge-empty">落子之后，这里会给出「妙手 / 好手 / 俗手 / 恶手」的点评与胜率损失。</div>';
      return;
    }
    if (d.pending) {
      box.innerHTML = '<div class="judge-empty">' + d.note + '</div>';
      return;
    }
    const g = AI.GRADES[d.grade];
    const lossPct = Math.max(0, Math.abs(d.delta) * 100);
    const sign = d.delta > 0.001 ? '−' : (d.delta < -0.001 ? '+' : '±');
    const lossCls = d.delta > 0.001 ? 'loss' : (d.delta < -0.001 ? 'gain' : '');
    const bestTxt = d.bestMove >= 0 ? coordText(d.bestMove) : '—';
    const band = d.band ? `（评估误差约 ±${(d.band * 100).toFixed(1)} 个百分点）` : '';
    let html =
      `<div class="judge-grade"><span class="judge-badge" style="color:${g.color}">${g.name}</span>` +
      `<span class="judge-note">${d.note}</span></div>` +
      `<div class="judge-rows">` +
      `<div class="judge-row"><span>本手后胜率</span><b>${(d.playedWR * 100).toFixed(1)}%</b></div>` +
      `<div class="judge-row"><span>与最佳着法的评估差距</span><b class="${lossCls}">${sign}${(d.delta * VALUE_SIGMA).toFixed(1)} 目</b></div>` +
      `<div class="judge-row"><span>引擎最佳着法</span><b>${bestTxt}</b></div>` +
      `</div>` +
      `<div class="judge-note judge-foot">差距小于噪声时判为「好手」，不把统计误差当成失误 ${band}</div>`;
    if (d.aiNote) html += `<div class="judge-ai">AI 这一手：<b style="color:${d.aiColor}">${d.aiNote}</b></div>`;
    box.innerHTML = html;
  }

  function renderMoves(moves, grades) {
    const box = $('move-list');
    if (!moves.length) { box.innerHTML = '<div class="judge-empty">—</div>'; return; }
    const parts = [];
    for (let i = 0; i < moves.length; i++) {
      const m = moves[i];
      const g = grades && grades[m.num];
      const mark = g && (g.grade === 'blunder' || g.grade === 'mundane')
        ? `<span class="loss-mark" title="${AI.GRADES[g.grade].name}">${AI.GRADES[g.grade].name}</span>` : '';
      const human = m.color === 'B' ? 'human' : '';
      parts.push(
        `<div class="mv ${human}"><span class="n">${m.num}.</span>` +
        `<span class="g" style="color:${m.color === 'B' ? '#e8b451' : '#7fb3ff'}">${coordText(m.p)}</span>${mark}</div>`
      );
    }
    box.innerHTML = parts.join('');
    box.scrollTop = box.scrollHeight;
  }

  function setTurn(dot, text) {
    $('turn-dot').className = 'dot ' + dot;
    $('turn-text').innerHTML = text;
  }

  function setThinking(on, text, pct) {
    const el = $('think');
    el.classList.toggle('hidden', !on);
    if (text) $('think-text').textContent = text;
    $('think-pct').textContent = pct === undefined ? '' : Math.round(pct * 100) + '%';
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 1800);
  }

  function showResult(title, bodyHtml) {
    $('result-title').textContent = title;
    $('result-body').innerHTML = bodyHtml;
    $('result').classList.remove('hidden');
  }
  function hideResult() { $('result').classList.add('hidden'); }

  /* ------------------------- 对外接口 ------------------------- */
  global.UI = {
    coordText, drawBoard, drawChart, layoutBoard, layoutChart, pointFromEvent,
    renderCandidates, renderJudge, renderMoves, setTurn, setThinking,
    toast, showResult, hideResult, setHoverHandler,
    view, L,
    setView(patch) { Object.assign(view, patch); drawBoard(); },
    redraw() { drawBoard(); }
  };
})(window);
