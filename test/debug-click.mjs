/* 定点诊断：点击 → 落子 → AI 应手 → 截图 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchChrome, CDP } from './cdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 8203;
const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), String(PORT)], { stdio: 'ignore' });
await new Promise(r => setTimeout(r, 800));

const { proc } = await launchChrome(9337);
try {
  const cdp = await CDP.attach(9337);
  await cdp.goto(`http://127.0.0.1:${PORT}/`);
  await new Promise(r => setTimeout(r, 2000));

  const before = await cdp.evaluate(`(() => {
    const cv = document.getElementById('board'); const r = cv.getBoundingClientRect();
    const { margin, cell } = window.UI.L;
    return {
      rect: { l: r.left, t: r.top, w: r.width },
      margin, cell,
      target: { x: r.left + margin + 4*cell, y: r.top + margin + 4*cell },
      stones: Array.from(window.GO9App.state.board.stones).filter(v => v===1||v===2).length,
      busy: window.GO9App.state.busy,
      analysisReady: window.GO9App.state.analysis !== null
    };
  })()`);
  console.log('落子前:', JSON.stringify(before));

  // 点 E5
  await cdp.clickAt(before.target.x, before.target.y);
  await new Promise(r => setTimeout(r, 800));
  const afterClick = await cdp.evaluate(`(() => {
    const s = window.GO9App.state;
    const stones = [];
    for (let p = 0; p < 121; p++) if (s.board.stones[p]===1||s.board.stones[p]===2) stones.push(p);
    return { moves: s.moves.length, stones, busy: s.busy, lastMove: s.board.lastMove };
  })()`);
  console.log('点击后:', JSON.stringify(afterClick), '（E5 的内部索引应为 56）');

  // 等 AI 应手
  await cdp.waitFor(`(() => window.GO9App.state.moves.length >= 2)()`, 60000).catch(() => 0);
  await new Promise(r => setTimeout(r, 1200));

  const state = await cdp.evaluate(`(() => {
    const s = window.GO9App.state;
    const stones = [];
    for (let p = 0; p < 121; p++) if (s.board.stones[p]===1||s.board.stones[p]===2) stones.push(p);
    return {
      moves: s.moves.length, stones,
      grades: Object.keys(s.grades).map(k => s.grades[k].grade),
      chart: s.chart.map(c => +(c.wr*100).toFixed(1)),
      wr: document.getElementById('wr-current').textContent,
      lead: document.getElementById('wr-lead').textContent,
      judge: document.getElementById('judge').textContent.replace(/\\s+/g,' ').trim(),
      cands: [...document.querySelectorAll('#cand-list .cand')].map(e => e.textContent.trim())
    };
  })()`);
  console.log('AI 应手后:', JSON.stringify(state, null, 1));

  await cdp.evaluate(`document.getElementById('chk-numbers').click()`);
  await new Promise(r => setTimeout(r, 500));
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'docs', 'screenshot.png'), Buffer.from(shot.data, 'base64'));
  console.log('截图已保存 docs/screenshot.png');
} catch (e) {
  console.log('异常:', e.message);
} finally {
  try { proc.kill(); } catch (e) { }
  try { server.kill(); } catch (e) { }
}
