import test from 'node:test';
import assert from 'node:assert/strict';
import { nextAlarm, runAccounts } from '../runner.js';

const accounts = [{ userId: 1, email: 'one@example.invalid' }, { userId: 2, email: 'two@example.invalid' }, { userId: 3, email: 'three@example.invalid' }];
function adapter(overrides = {}) {
  const calls = [];
  const progress = [];
  return {
    calls, records: progress,
    inspect: async () => ({ ok: true, accounts, original: accounts[0] }),
    checkin: async account => { calls.push(account.email); return { ok: true, email: account.email, message: 'Checkin!' }; },
    restore: async account => { calls.push('restore:' + account.email); return { ok: true, email: account.email }; },
    progress: async run => { progress.push(structuredClone(run)); },
    ...overrides
  };
}
test('signs every saved account serially and returns to the original account', async () => {
  const task = adapter();
  const result = await runAccounts(task);
  assert.deepEqual(task.calls, [...accounts.map(a => a.email), 'restore:' + accounts[0].email]);
  assert.equal(result.state, 'success');
  assert.equal(task.records[0].results.length, 0);
  assert.equal(task.records[0].original.email, accounts[0].email);
  assert.equal(task.records.at(-1).restoration.ok, true);
});
test('one expired account does not block the remaining accounts', async () => {
  const visited = [];
  const task = adapter({ checkin: async account => {
    visited.push(account.userId);
    if (account.userId === 2) return { ok: false, message: '请重新登录' };
    return { ok: true, email: account.email };
  }});
  const result = await runAccounts(task);
  assert.deepEqual(visited, [1, 2, 3]);
  assert.equal(result.state, 'partial');
  assert.equal(result.results.filter(a => a.ok).length, 2);
  assert.equal(result.restoration.ok, true);
});
test('unknown execution errors are recorded once and never replayed', async () => {
  let count = 0;
  const task = adapter({ checkin: async account => { count++; if (account.userId === 1) throw new Error('worker response lost'); return { ok: true, email: account.email }; } });
  const result = await runAccounts(task);
  assert.equal(count, 3);
  assert.equal(result.results[0].unknown, true);
  assert.equal(result.restoration.ok, true);
});
test('unexpected returned identity cannot count as success', async () => {
  const task = adapter({ checkin: async () => ({ ok: true, email: 'wrong@example.invalid' }) });
  const result = await runAccounts(task);
  assert.equal(result.state, 'failed');
  assert.ok(result.results.every(item => !item.ok));
  assert.equal(result.restoration.ok, true);
});
test('restoration failure is not reported as a successful batch', async () => {
  const task = adapter({ restore: async () => ({ ok: false, message: '恢复超时' }) });
  const result = await runAccounts(task);
  assert.equal(result.state, 'partial');
  assert.equal(result.restoration.ok, false);
  assert.match(result.restoration.message, /恢复超时/);
});
test('restores the original account even when writing intermediate progress fails', async () => {
  let writes = 0;
  let restored = false;
  const task = adapter({
    progress: async () => { if (++writes === 3) throw new Error('storage unavailable'); },
    restore: async account => { restored = true; return { ok: true, email: account.email }; }
  });
  await assert.rejects(runAccounts(task), /storage unavailable/);
  assert.equal(restored, true);
});
test('failed discovery performs no account switch', async () => {
  const task = adapter({ inspect: async () => ({ ok: false, message: '未登录' }) });
  await assert.rejects(runAccounts(task), /未登录/);
  assert.deepEqual(task.calls, []);
});
test('alarms stay anchored to the next local 09:35 and 21:35', () => {
  const now = new Date(2026, 10, 2, 10, 0, 0);
  assert.equal(nextAlarm(9, now), new Date(2026, 10, 3, 9, 35, 0).getTime());
  assert.equal(nextAlarm(21, now), new Date(2026, 10, 2, 21, 35, 0).getTime());
});
