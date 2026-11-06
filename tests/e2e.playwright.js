async page => {
  const context = page.context();
  for (const previous of context.pages()) if (previous !== page) await previous.close();
  const worker = context.serviceWorkers().find(item => item.url().endsWith('/background.js'));
  if (!worker) throw new Error('Extension service worker is not loaded');
  const extensionId = worker.url().split('/')[2];
  const accounts = [
    { userId: 1, email: 'one@example.invalid' },
    { userId: 2, email: 'two@example.invalid' },
    { userId: 3, email: 'three@example.invalid' }
  ];
  const balances = { 1: 320, 2: 120, 3: 80 };
  const validity = { 1: 20, 2: 20, 3: 20 };
  const plans = { plan100: { points: 100, days: 10 }, plan200: { points: 200, days: 30 }, plan500: { points: 500, days: 100 } };
  const awards = Array.from({ length: 7 }, (_, index) => ({ business: 'system:checkin', time: Date.now() - index * 86400000, change: '10.0' }));
  let current = 1;
  let expired = false;
  let loseExchange = false;
  const signed = [];
  const exchanges = [];
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await context.route('https://glados.cloud/**', async route => {
    const request = route.request();
    const path = request.url().split('glados.cloud')[1].split('?')[0];
    let body;
    if (!path.startsWith('/api/')) {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><span id="mail" onclick="document.getElementById(\'add\').hidden=false">' + accounts.find(a => a.userId === current).email + '</span><button id="add" hidden onclick="document.getElementById(\'login\').hidden=false">Add account</button><form id="login" hidden><label>GLaDOS 登录邮箱<input type="email"></label></form></body></html>' });
      return;
    }
    if (path === '/api/user/status') {
      const email = accounts.find(a => a.userId === current).email;
      // 扩展 tabs.create 的首个导航可能早于 Playwright 挂上路由。
      // 在状态接口返回前建立登录 DOM fixture，避免真实应用静态资源影响本地 UI 测试。
      if (request.frame().url() === 'https://glados.cloud/console') {
        await request.frame().evaluate(email => {
          const mail = document.createElement('span'); mail.textContent = email;
          const add = document.createElement('button'); add.textContent = 'Add account'; add.hidden = true;
          const login = document.createElement('form'); login.id = 'login'; login.hidden = true;
          const input = document.createElement('input'); input.type = 'email'; login.append(input);
          mail.addEventListener('click', () => { add.hidden = false; });
          add.addEventListener('click', () => { login.hidden = false; });
          document.body.replaceChildren(mail, add, login);
        }, email);
      }
      body = { code: 0, data: { email, leftDays: validity[current].toFixed(1) } };
    }
    else if (path === '/api/user/accounts') body = { code: 0, data: accounts.map(a => ({ ...a, current: a.userId === current })), max: 5 };
    else if (path === '/api/user/accounts/switch') { current = request.postDataJSON().userId; body = { code: 0 }; }
    else if (path === '/api/user/checkin') {
      if (expired && current === 2) body = { code: 4, message: '请重新登录' };
      else { signed.push(current); balances[current] += 10; body = { code: 0, message: 'Checkin! Got 10 Points' }; }
    } else if (path === '/api/user/points') body = { code: 0, points: balances[current].toFixed(1), plans, history: awards };
    else if (path === '/api/user/exchange') {
      const planType = request.postDataJSON().planType;
      const offer = plans[planType];
      if (!offer || balances[current] < offer.points) body = { code: 4, message: 'Invalid fixture exchange' };
      else {
        exchanges.push({ userId: current, planType });
        balances[current] -= offer.points;
        validity[current] += offer.days;
        if (loseExchange) { loseExchange = false; await route.abort('failed'); return; }
        body = { code: 0, message: 'Fixture exchanged', points: balances[current].toFixed(1) };
      }
    } else throw new Error('Unexpected API request ' + path);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('chrome-extension://' + extensionId + '/popup.html');
  await page.waitForFunction(() => document.querySelectorAll('.account').length === 3 && !document.getElementById('run').disabled);
  await page.getByRole('button', { name: '全部签到', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('message').textContent.includes('成功 3/3') && !document.getElementById('run').disabled);
  if (current !== 1 || signed.join(',') !== '1,2,3') throw new Error('Three-account batch failed or did not restore the original account');
  if (exchanges.length !== 1 || exchanges[0].userId !== 2 || exchanges[0].planType !== 'plan100' || balances[2] !== 30 || validity[2] !== 30) {
    throw new Error('Expiry redemption did not use the correct account or update the native balance/validity');
  }
  const firstRun = await page.evaluate(async () => (await chrome.storage.local.get('lastRun')).lastRun);
  if (!firstRun.results[1].redemption.receipts.every(receipt => receipt.verified)) throw new Error('Redemption receipt was not verified');
  await page.setViewportSize({ width: 380, height: 600 });
  await page.screenshot({ path: 'evidence/three-accounts.png', fullPage: true });

  await page.getByLabel('自动签到', { exact: false }).check();
  const alarmNames = await page.evaluate(async () => {
    for (let i = 0; i < 100; i++) {
      const alarms = await chrome.alarms.getAll();
      if (alarms.length === 2) return alarms.map(a => a.name).sort();
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Daily alarms were not registered');
  });
  if (alarmNames.join(',') !== 'checkin-21,checkin-9') throw new Error('Both daily alarms must be registered');
  await page.getByLabel('自动签到', { exact: false }).uncheck();
  await page.evaluate(async () => {
    for (let i = 0; i < 100; i++) {
      if ((await chrome.alarms.getAll()).length === 0) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Disabled alarms were not cleared');
  });

  balances[1] = 700;
  exchanges.length = 0;
  await page.getByRole('button', { name: '全部签到', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('message').textContent.includes('成功 3/3') && !document.getElementById('run').disabled);
  if (balances[1] !== 210 || validity[1] !== 120 || exchanges.filter(row => row.userId === 1).map(row => row.planType).join(',') !== 'plan500') {
    throw new Error('500-first strategy consumed the smaller remainder or failed to extend validity');
  }
  await page.getByLabel('自动兑换天数', { exact: false }).uncheck();
  await page.waitForFunction(() => !document.getElementById('auto-redeem').disabled);
  balances[1] = 700;
  exchanges.length = 0;
  await page.getByRole('button', { name: '全部签到', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('message').textContent.includes('成功 3/3') && !document.getElementById('run').disabled);
  if (exchanges.length || balances[1] !== 710) throw new Error('Disabled automatic redemption still consumed points');
  await page.getByLabel('自动兑换天数', { exact: false }).check();
  await page.waitForFunction(() => !document.getElementById('auto-redeem').disabled);

  expired = true;
  signed.length = 0;
  await page.getByRole('button', { name: '全部签到', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('message').textContent.includes('成功 2/3') && !document.getElementById('run').disabled);
  if (current !== 1 || signed.join(',') !== '1,3') throw new Error('Expired account prevented continuation or restoration');
  if (!(await page.locator('.account-result.error').innerText()).includes('请重新登录')) throw new Error('Account-level failure is missing');

  current = 2;
  const interruptedId = await page.evaluate(() => crypto.randomUUID());
  const exchangeCountBeforeRestart = exchanges.length;
  await page.evaluate(async ({ original, id }) => {
    await chrome.storage.local.set({ journal: { original, runId: id }, lastRun: { id, state: 'running', results: [], original,
      pendingRedemption: { account: { userId: 2, email: 'two@example.invalid' }, decision: { action: 'redeem', spentPoints: 200 } } } });
  }, { original: accounts[0], id: interruptedId });
  const cdp = await context.newCDPSession(page);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await page.reload();
  const recovery = await page.evaluate(async id => {
    for (let i = 0; i < 100; i++) {
      const saved = await chrome.storage.local.get(['journal', 'lastRun']);
      if (!saved.journal && saved.lastRun?.id === id && saved.lastRun.state === 'interrupted' && saved.lastRun.restoration?.ok) {
        const status = await (await fetch('https://glados.cloud/api/user/status', { credentials: 'include' })).json();
        if (status.data?.email !== 'one@example.invalid') throw new Error('Actual session was not restored');
        return saved.lastRun;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Restart recovery did not finish: ' + JSON.stringify(await chrome.storage.local.get(['journal', 'lastRun'])));
  }, interruptedId);
  if (recovery.state !== 'interrupted' || !recovery.restoration?.ok) throw new Error('Interrupted run must not masquerade as success');
  if (exchanges.length !== exchangeCountBeforeRestart) throw new Error('Worker restart replayed a pending financial request');

  await page.getByRole('button', { name: '添加账号', exact: true }).click();
  await page.waitForFunction(() => !document.getElementById('add').disabled);
  const loginPage = context.pages().filter(p => p.url() === 'https://glados.cloud/console').at(-1);
  if (!loginPage) throw new Error('Native account login tab was not opened');
  await loginPage.locator('#login').waitFor({ state: 'visible' });
  await loginPage.close();
  if (errors.length) throw new Error(errors.join('\n'));
  const unexpected = context.pages().filter(p => p !== page && p.url().startsWith('https://glados.cloud/'));
  if (unexpected.length) throw new Error('Background task leaked its own tabs');
  return { loaded: true, multiAccountBatch: '3/3', partialFailure: '2/3 and restored', alarms: alarmNames,
    workerRestartRecovery: recovery.state, nativeAddAccount: true, expiryRedemption: true,
    target500PreservesRemainder: true, disableRedemption: true, noFinancialReplayAfterRestart: true, pageErrors: errors,
    screenshot: 'evidence/three-accounts.png' };
}
