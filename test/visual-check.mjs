/* 视觉验证：走到中盘后截图，并测量 AI 每手耗时 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchChrome, CDP } from './cdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 8201;
const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), String(PORT)], { stdio: 'ignore' });
await new Promise(r => setTimeout(r, 800));

const { proc } = await launchChrome(9335);
try {
  const cdp = await CDP.attach(9335);
  await cdp.goto(`http://127.0.0.1:${PORT}/`);
  await new Promise(r => setTimeout(r, 1500));

  // 走 4 手，统计 AI 耗时
  const times = [];
  for (let i = 0; i < 4; i++) {
    console.log(`  [${i}] 等待引擎空闲…`);
    await cdp.waitFor(`(() => { const s = window.GO9App.state; return !s.busy && !s.over; })()`, 90000).catch(() => 0);
    const before = await cdp.evaluate(`window.GO9App.state.moves.length`);

    // 依次尝试若干候选点，直到真的落下一手
    let placed = false;
    for (let attempt = 0; attempt < 6 && !placed; attempt++) {
      const p = await cdp.evaluate(`(() => {
        const cv = document.getElementById('board'); const r = cv.getBoundingClientRect();
        const { margin, cell } = window.UI.L;
        const s = window.GO9App.state;
        const E = window.GO9App.E;
        const cand = [[0,0],[8,0],[0,8],[8,8],[4,4],[2,6],[6,2],[6,6],[4,2],[2,4]];
        const [col,row] = cand[${attempt}];
        const cellIdx = (row+1)*11 + (col+1);
        if (s.board.stones[cellIdx] !== 0) return null;
        if (!E.isLegalMove(s.board, cellIdx, s.board.toPlay)) return null;
        return { x: r.left + margin + col*cell, y: r.top + margin + row*cell };
      })()`);
      if (!p) continue;
      await cdp.clickAt(p.x, p.y);
      await new Promise(r => setTimeout(r, 600));
      placed = await cdp.evaluate(`window.GO9App.state.moves.length > ${before}`);
    }
    if (!placed) { console.log('  [!] 找不到可落子的点，跳过'); continue; }

    const t0 = Date.now();
    await cdp.waitFor(`(() => window.GO9App.state.moves.length >= ${before + 2})()`, 90000).catch(() => 0);
    times.push(Date.now() - t0);
    console.log(`  [${i}] AI 应手用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  // 打开「手数」显示，再截一张图
  await cdp.evaluate(`document.getElementById('chk-numbers').click()`);
  await new Promise(r => setTimeout(r, 400));
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'docs', 'screenshot.png'), Buffer.from(shot.data, 'base64'));
  console.log('截图已保存：docs/screenshot.png');

  const summary = await cdp.evaluate(`(() => {
    const s = window.GO9App.state;
    return {
      moves: s.moves.length,
      grades: Object.keys(s.grades).map(k => s.grades[k].grade),
      chart: s.chart.map(c => +(c.wr*100).toFixed(1)),
      wr: document.getElementById('wr-current').textContent,
      lead: document.getElementById('wr-lead').textContent,
      cands: [...document.querySelectorAll('#cand-list .cand')].map(e => e.textContent.trim()),
      judge: document.getElementById('judge').textContent.replace(/\\s+/g,' ').trim()
    };
  })()`);
  console.log('\n手数:', summary.moves);
  console.log('各手点评:', summary.grades.join(' '));
  console.log('胜率曲线(黑%):', summary.chart.join(' → '));
  console.log('当前:', summary.wr, '|', summary.lead);
  console.log('候选:', summary.cands.join(' | '));
  console.log('点评面板:', summary.judge);
  console.log('AI 每手耗时(秒):', times.map(t => (t / 1000).toFixed(1)).join(', '));
} catch (e) {
  console.log('异常:', e.message);
} finally {
  try { proc.kill(); } catch (e) { }
  try { server.kill(); } catch (e) { }
}
