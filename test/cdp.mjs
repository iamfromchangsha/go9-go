/* 最小 CDP 客户端：用 Node 内置 WebSocket 直连 Chrome DevTools Protocol */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

export async function launchChrome(port = 9333) {
  const profile = path.join(os.tmpdir(), 'go9-cdp-' + Date.now());
  fs.mkdirSync(profile, { recursive: true });
  const proc = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--window-size=1400,900',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile,
    'about:blank'
  ], { stdio: 'ignore' });

  // 等待调试端口就绪
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) break;
    } catch (e) { /* 继续等 */ }
    await new Promise(r => setTimeout(r, 250));
  }
  return { proc, profile, port };
}

export class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message + ' ' + JSON.stringify(msg.error.data || '')));
        else resolve(msg.result);
      } else if (msg.method) {
        this.listeners.forEach(fn => fn(msg));
      }
    });
  }

  static async attach(port, timeoutMs = 20000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const page = list.find(t => t.type === 'page');
        if (page) {
          const ws = new WebSocket(page.webSocketDebuggerUrl);
          await new Promise((res, rej) => {
            ws.addEventListener('open', res, { once: true });
            ws.addEventListener('error', rej, { once: true });
          });
          const cdp = new CDP(ws);
          await cdp.send('Page.enable');
          await cdp.send('Runtime.enable');
          return cdp;
        }
      } catch (e) { /* 重试 */ }
      await new Promise(r => setTimeout(r, 300));
    }
    throw new Error('无法连接到 Chrome 调试端口');
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP 超时: ' + method));
        }
      }, 60000);
    });
  }

  on(fn) { this.listeners.push(fn); }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true
    });
    if (r.exceptionDetails) {
      throw new Error('页面异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  }

  async goto(url) {
    const loaded = new Promise(res => {
      const fn = msg => { if (msg.method === 'Page.loadEventFired') res(); };
      this.on(fn);
    });
    await this.send('Page.navigate', { url });
    await loaded;
  }

  /** 在 CSS 坐标处真实派发一次鼠标点击 */
  async clickAt(x, y) {
    const base = { x, y, button: 'left', clickCount: 1, buttons: 1 };
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base, buttons: 0 });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 });
  }

  async waitFor(expression, timeoutMs = 30000, interval = 200) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const v = await this.evaluate(expression);
      if (v) return v;
      await new Promise(r => setTimeout(r, interval));
    }
    throw new Error('等待超时: ' + expression);
  }
}
