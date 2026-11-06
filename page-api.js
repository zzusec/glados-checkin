// 此函数会完整注入 GLaDOS 标签页，必须保持自包含；不读取或导出 Cookie。
export async function pageAction(input) {
  const result = { ok: false, stage: input.op, warnings: [], checkinAttempted: false };
  const numeric = (value, label) => {
    if (typeof value !== 'number' && !(typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()))) {
      throw new Error(label + '无效');
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(label + '无效');
    return parsed;
  };
  const request = async (path, body, timeout = 25000) => {
    const response = await fetch('/api' + path, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'include', cache: 'no-store',
      ...(body === undefined ? {} : {
        headers: { 'Content-Type': 'application/json;charset=UTF-8' },
        body: JSON.stringify(body)
      }),
      signal: AbortSignal.timeout(timeout)
    });
    const data = await response.json();
    if (!response.ok || data.code !== 0) {
      throw new Error(path + ': HTTP ' + response.status + ', ' + (data.message || 'code=' + data.code));
    }
    return data;
  };
  const current = async () => {
    const { data } = await request('/user/status');
    if (!data || typeof data.email !== 'string' || !data.email) throw new Error('当前账号未登录，请先在网站添加账号');
    return data;
  };
  const validateTarget = target => {
    if (!target || !['number', 'string'].includes(typeof target.userId) || !String(target.userId) ||
        typeof target.email !== 'string' || !target.email) throw new Error('目标账号资料不完整，未执行切换');
  };
  const select = async target => {
    validateTarget(target);
    let account = await current();
    if (account.email !== target.email) {
      result.stage = 'switch';
      await request('/user/accounts/switch', { userId: target.userId });
      account = await current();
    }
    if (account.email !== target.email) throw new Error('账号核对失败：预期 ' + target.email + '，实际 ' + account.email + '，未执行签到');
    result.email = account.email;
    result.leftDays = account.leftDays;
    return account;
  };

  try {
    if (location.hostname !== 'glados.cloud') throw new Error('只允许在 glados.cloud 页面执行');
    if (input.op === 'add-account') {
      if (location.pathname.startsWith('/login')) return { ok: true, loginPage: true };
      const account = await current();
      // 只打开网站自己的“添加账号”对话框，密码和验证码仍交给网站处理。
      const findAdd = () => [...document.querySelectorAll('button')]
        .find(node => /^(Add account|添加账号|添加帐号)$/i.test(node.textContent.trim()));
      let button = findAdd();
      if (!button) {
        const email = [...document.querySelectorAll('span,button,a')]
          .find(node => node.textContent.trim() === account.email);
        if (!email) throw new Error('未找到当前邮箱菜单，请在 GLaDOS 页面点击邮箱 → 添加账号');
        email.click();
        for (let attempt = 0; attempt < 20 && !button; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 100));
          button = findAdd();
        }
      }
      if (!button) throw new Error('未找到添加入口，可能已达到网站账号上限；请从邮箱菜单查看');
      button.click();
      return { ok: true, opened: true };
    }
    if (input.op === 'accounts') {
      const [list, status] = await Promise.all([request('/user/accounts'), current()]);
      if (!Array.isArray(list.data) || !list.data.length) throw new Error('网站未返回已保存账号，请先添加账号');
      const accounts = list.data.map(account => {
        validateTarget(account);
        return { userId: account.userId, email: account.email, current: account.email === status.email };
      });
      const original = accounts.filter(account => account.current);
      if (original.length !== 1 || new Set(accounts.map(account => String(account.userId))).size !== accounts.length) {
        throw new Error('账号列表与当前会话不一致，停止操作');
      }
      return { ok: true, accounts, original: original[0], max: list.max, leftDays: status.leftDays };
    }
    if (!['checkin', 'restore', 'redeem'].includes(input.op)) throw new Error('不支持的操作');
    await select(input.account);
    if (input.op === 'restore') return { ...result, ok: true, stage: 'restored' };
    if (input.op === 'redeem') {
      result.stage = 'redemption';
      result.redemptionAttempted = false;
      result.receipts = [];
      const decision = input.decision;
      const initial = await request('/user/points');
      let balance = numeric(initial.points, '当前积分余额');
      let leftDays = numeric(result.leftDays, '当前有效期');
      if (!decision || decision.action !== 'redeem' || !Array.isArray(decision.steps) || !decision.steps.length ||
          Math.abs(balance - numeric(decision.balance, '计划余额')) > 0.000001 ||
          leftDays > numeric(decision.leftDays, '计划有效期') + 0.001) {
        throw new Error('兑换判断后的余额或有效期已变化，未自动提交，请刷新后重算');
      }
      let totalCost = 0;
      let totalDays = 0;
      for (const step of decision.steps) {
        const offer = initial.plans?.[step.planType];
        if (!offer || !Number.isSafeInteger(step.count) || step.count <= 0 ||
            !Number.isSafeInteger(step.points) || step.points <= 0 || !Number.isSafeInteger(step.days) || step.days <= 0 ||
            numeric(offer.points, '兑换档位积分') !== step.points || numeric(offer.days, '兑换档位天数') !== step.days) {
          throw new Error('兑换档位已变化或组合无效，未自动花积分');
        }
        totalCost += step.count * step.points;
        totalDays += step.count * step.days;
      }
      if (!Number.isSafeInteger(totalCost) || totalCost > balance || totalCost !== decision.spentPoints || totalDays !== decision.gainedDays) {
        throw new Error('兑换组合超出余额或与计算不一致，未自动提交');
      }
      for (const step of decision.steps) {
        for (let count = 0; count < step.count; count++) {
          // 每次扣分前重新核对身份、余额和档位；任何未知结果都停止，不重复 POST。
          const [account, before] = await Promise.all([current(), request('/user/points')]);
          if (account.email !== input.account.email || Math.abs(numeric(before.points, '兑换前余额') - balance) > 0.000001 ||
              numeric(before.plans?.[step.planType]?.points, '兑换档位积分') !== step.points ||
              numeric(before.plans?.[step.planType]?.days, '兑换档位天数') !== step.days) {
            throw new Error('兑换期间账号、余额或档位发生变化，已停止后续兑换');
          }
          leftDays = numeric(account.leftDays, '兑换前有效期');
          result.redemptionAttempted = true;
          const acknowledgement = await request('/user/exchange', { planType: step.planType }, 45000);
          const receipt = { planType: step.planType, points: step.points, days: step.days,
            confirmed: true, verified: false, beforePoints: balance, beforeDays: leftDays, message: acknowledgement.message };
          result.receipts.push(receipt);
          for (let attempt = 0; attempt < 3; attempt++) {
            if (attempt) await new Promise(resolve => setTimeout(resolve, 500));
            const [afterAccount, after] = await Promise.all([current(), request('/user/points')]);
            if (afterAccount.email !== input.account.email) throw new Error('兑换后账号被其他页面切换，结果需核实');
            const afterPoints = numeric(after.points, '兑换后余额');
            const afterDays = numeric(afterAccount.leftDays, '兑换后有效期');
            result.points = after.points;
            result.leftDays = afterAccount.leftDays;
            receipt.afterPoints = afterPoints;
            receipt.afterDays = afterDays;
            // leftDays 可能按整天取整；跨日允许最多一天的显示差，但必须实际延长。
            if (Math.abs(afterPoints - (balance - step.points)) < 0.000001 &&
                afterDays > leftDays && afterDays >= leftDays + step.days - 1.001) {
              receipt.verified = true;
              balance = afterPoints;
              leftDays = afterDays;
              break;
            }
          }
          if (!receipt.verified) throw new Error('兑换接口已确认，但扣分或有效期变化未核实；已停止后续兑换，请查看网站');
        }
      }
      return { ...result, ok: true, stage: 'redeemed', spentPoints: totalCost, gainedDays: totalDays,
        message: '已兑换 ' + totalCost + ' 积分，档位合计 ' + totalDays + ' 天' };
    }

    result.stage = 'checkin';
    result.checkinAttempted = true;
    const response = await fetch('/api/user/checkin', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json;charset=UTF-8' },
      body: JSON.stringify({ token: location.hostname }),
      signal: AbortSignal.timeout(45000)
    });
    result.httpStatus = response.status;
    const data = await response.json();
    result.code = data.code;
    result.message = data.message || '签到接口未返回 message';
    result.already = /^(Checkin Repeats!|Today's observation logged\.)/.test(result.message);
    result.ok = response.ok && ((data.code === 0 && /^Checkin!/.test(result.message)) ||
      ([0, 1].includes(data.code) && result.already));
    if (!result.ok) return result;

    // 附加查询失败只显示警告，不重复已提交的签到。
    try {
      const [status, points] = await Promise.all([current(), request('/user/points', undefined, 15000)]);
      if (status.email !== input.account.email) throw new Error('运行期间账号被其他页面切换，未采纳积分信息');
      result.leftDays = status.leftDays;
      result.points = points.points;
      result.redemptionSnapshot = { points: points.points, leftDays: status.leftDays, plans: points.plans,
        history: (Array.isArray(points.history) ? points.history : []).filter(row => row.business === 'system:checkin')
          .map(row => ({ business: row.business, time: row.time, change: row.change, detail: row.detail })) };
    } catch (error) {
      result.warnings.push(String(error));
    }
    return result;
  } catch (error) {
    return { ...result, ok: false, message: String(error), unknown: result.checkinAttempted || result.redemptionAttempted === true };
  }
}
