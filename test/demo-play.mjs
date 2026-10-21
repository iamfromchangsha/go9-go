/* 演示：真实应用里对弈若干手，抓出 AI 每一手的落点与线位，并截图
 * 运行： node test/demo-play.mjs
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchChrome, CDP } from './cdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 8211;
const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), String(PORT)], { stdio: 'ignore' });
await new Promise(r => setTimeout(r, 800));

const { proc } = await launchChrome(9341);
try {
  const cdp = await CDP.attach(9341);
  await cdp.goto(`http://127.0.0.1:${PORT}/`);
  await new Promise(r => setTimeout(r, 1500));

  // 人类走三线/四线的正常点
  const humanPts = [[2, 2], [6, 6], [6, 2], [2, 6], [4, 4], [3, 6]];

  for (const [col, row] of humanPts) {
    await cdp.waitFor(`(() => { const s = window.GO9App.state; return !s.busy && !s.over; })()`, 120000).catch(() => 0);
    const p = await cdp.evaluate(`(() => {
      const cv = document.getElementById('board'); const r = cv.getBoundingClientRect();
      const { margin, cell } = window.UI.L;
      const s = window.GO9App.state;
      const E = window.GO9App.E;
      const cellIdx = (${row}+1)*11 + (${col}+1);
      if (s.board.stones[cellIdx] !== 0) return null;
      if (!E.isLegalMove(s.board, cellIdx, s.board.toPlay)) return null;
      return { x: r.left + margin + ${col}*cell, y: r.top + margin + ${row}*cell };
    })()`);
    if (!p) continue;
    await cdp.clickAt(p.x, p.y);
    await new Promise(r => setTimeout(r, 500));
  }

  await cdp.waitFor(`(() => { const s = window.GO9App.state; return !s.busy && !s.over; })()`, 120000).catch(() => 0);
  await new Promise(r => setTimeout(r, 1200));

  const info = await cdp.evaluate(`(() => {
    const s = window.GO9App.state;
    const E = window.GO9App.E;
    const moves = s.moves.map(m => {
      const x = E.xOf(m.p), y = E.yOf(m.p);
      const line = Math.min(x, y, 8-x, 8-y);
      return { num: m.num, color: m.color, x, y, line };
    });
    return {
      moves,
      grades: Object.keys(s.grades).sort((a,b)=>a-b).map(k => s.grades[k].grade),
      chart: s.chart.map(c => +(c.wr*100).toFixed(1)),
      wr: document.getElementById('wr-current').textContent,
      lead: document.getElementById('wr-lead').textContent,
      cands: [...document.querySelectorAll('#cand-list .cand')].map(e => e.textContent.trim()),
      judge: document.getElementById('judge').textContent.replace(/\\s+/g,' ').trim(),
      ver: document.getElementById('ver').textContent
    };
  })()`);

  const lineName = ['一线', '二线', '三线', '四线', '五线'];
  console.log('版本:', info.ver);
  console.log('\n手数  颜色  坐标     线位');
  for (const m of info.moves) {
    const who = m.color === 'B' ? '黑(人)' : '白(AI)';
    console.log(`${String(m.num).padStart(3)}   ${who}   (${m.x},${m.y})   ${lineName[m.line]}`);
  }
  const ai = info.moves.filter(m => m.color === 'W');
  console.log(`\nAI 落子线位：${ai.map(m => lineName[m.line]).join(' ')}`);
  console.log(`AI 一线手数：${ai.filter(m => m.line === 0).length}   二线手数：${ai.filter(m => m.line === 1).length}`);
  console.log('各手点评:', info.grades.join(' '));
  console.log('胜率曲线(你的%):', info.chart.join(' → '));
  console.log('当前:', info.wr, '|', info.lead);
  console.log('候选:', info.cands.join(' | '));
  console.log('点评:', info.judge);

  await cdp.evaluate(`document.getElementById('chk-numbers').click()`);
  await new Promise(r => setTimeout(r, 400));
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
  const out = path.join(ROOT, 'docs', 'screenshot-fixed.png');
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('\n截图已保存:', out);
} catch (e) {
  console.log('异常:', e.message);
} finally {
  try { proc.kill(); } catch (e) { }
  try { server.kill(); } catch (e) { }
}
