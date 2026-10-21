/* 快速诊断：页面加载后有没有 JS 报错 */
import { launchChrome, CDP } from './cdp.mjs';
const { proc } = await launchChrome(9334);
try {
  const cdp = await CDP.attach(9334);
  await cdp.goto('http://127.0.0.1:8123/');
  await new Promise(r => setTimeout(r, 1500));
  const errs = await cdp.evaluate('JSON.stringify(window.__errs || [])');
  console.log('页面错误：', errs);
  const app = await cdp.evaluate('typeof window.GO9App + " | " + (window.GO9App ? Object.keys(window.GO9App).join(",") : "-")');
  console.log('GO9App：', app);
  const cons = await cdp.evaluate('JSON.stringify(window.__consoleErrors || [])');
  console.log('其他：', cons);
} catch (e) {
  console.log('诊断异常：', e.message);
} finally {
  try { proc.kill(); } catch (e) { }
}
