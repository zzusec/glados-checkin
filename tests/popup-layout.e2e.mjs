// 测试真实工具栏弹窗，而不是手动设成 380px 的普通标签页。
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const profile = await mkdtemp(join(tmpdir(), 'glados-native-popup-'));
const fixtures = ['one@example.invalid', 'two@example.invalid', 'three@example.invalid']
  .slice(0, Number(process.env.FIXTURE_ACCOUNTS || 1))
  .map((email, index) => ({ userId: index + 1, email, current: index === 0 }));
assert.ok(fixtures.length, 'At least one fixture account is required');
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: false,
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    args: ['--disable-extensions-except=' + root, '--load-extension=' + root],
    viewport: { width: 1100, height: 750 }, deviceScaleFactor: 2
  });
  await context.route('https://glados.cloud/**', route => {
    const path = new URL(route.request().url()).pathname;
    const account = fixtures[0];
    const body = path === '/api/user/accounts' ? { code: 0, data: fixtures, max: 5 }
      : path === '/api/user/status' ? { code: 0, data: { ...account, leftDays: '20.0' } }
      : null;
    return route.fulfill({ contentType: body ? 'application/json' : 'text/html', body: body ? JSON.stringify(body) : '<!doctype html><title>GLaDOS layout fixture</title>' });
  });
  const hostPage = await context.newPage();
  await hostPage.bringToFront();
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).hostname;
  await worker.evaluate(async accounts => {
    await chrome.storage.local.set({ accounts, lastRefresh: Date.now() });
  }, fixtures);
  const cdp = await context.browser().newBrowserCDPSession();
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) throw new Error('Layout test has no browser window');
    await chrome.action.openPopup({ windowId: tab.windowId });
  });
  let target;
  for (let i = 0; i < 100; i++) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    target = targetInfos.find(item => item.url === 'chrome-extension://' + extensionId + '/popup.html');
    if (target) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(target, 'Chrome did not create a toolbar popup target');
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
  let nextId = 0;
  const pending = new Map();
  cdp.on('Target.receivedMessageFromTarget', event => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject, timer } = pending.get(message.id);
    clearTimeout(timer); pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timed out')); }, 10000);
    pending.set(id, { resolve, reject, timer });
    cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(error => {
      clearTimeout(timer); pending.delete(id); reject(error);
    });
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await evaluate(`new Promise(resolve => {
    const check = () => document.readyState === 'complete' && document.querySelector('.account') ? resolve(true) : setTimeout(check, 50);
    check();
  })`);
  const metrics = await evaluate(`(async () => {
    let previous = '', stable = 0;
    for (let i = 0; i < 30 && stable < 3; i++) {
      const size = innerWidth + 'x' + innerHeight;
      stable = size === previous ? stable + 1 : 0;
      previous = size;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { width:r.width, height:r.height, top:r.top, bottom:r.bottom }; };
    return { width:innerWidth, height:innerHeight, scrollWidth:document.documentElement.scrollWidth,
      heading:rect('h1'), header:rect('header'), run:rect('#run'), add:rect('#add'), footer:rect('footer'), scale:devicePixelRatio };
  })()`);
  await mkdir(join(root, 'evidence'), { recursive: true });
  const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const label = process.env.EVIDENCE_LABEL || 'popup-native';
  await writeFile(join(root, 'evidence', label + '.png'), Buffer.from(screenshot.data, 'base64'));
  await writeFile(join(root, 'evidence', label + '.json'), JSON.stringify(metrics, null, 2) + '\n');
  console.log(JSON.stringify(metrics));
  assert.ok(metrics.width >= 378 && metrics.width <= 382, 'Popup must request its real 380px width');
  assert.ok(metrics.scrollWidth <= metrics.width, 'No horizontal page overflow');
  assert.ok(metrics.heading.height <= 30, 'Heading must stay on one line');
  assert.ok(metrics.run.height <= 48 && metrics.add.height <= 48, 'Action buttons must not become vertical text');
  assert.ok(metrics.height <= 600 && metrics.footer.bottom <= metrics.height + 1, 'Footer must remain inside the popup');
  console.log('Native toolbar popup layout passed');
} finally {
  if (context) await context.close();
  await rm(profile, { recursive: true, force: true });
}
