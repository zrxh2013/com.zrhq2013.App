'use strict';

const $ = (id) => document.getElementById(id);

const ui = {
  network: $('network'),
  netBadge: $('netBadge'),
  pk: $('pk'),
  btnUnlock: $('btnUnlock'),
  btnLock: $('btnLock'),
  btnRefresh: $('btnRefresh'),
  address: $('address'),
  trxBalance: $('trxBalance'),
  usdtBalance: $('usdtBalance'),
  to: $('to'),
  amount: $('amount'),
  memo: $('memo'),
  btnEstimate: $('btnEstimate'),
  btnSend: $('btnSend'),
  estimate: $('estimate'),
  result: $('result'),
  error: $('error'),
  btnExport: $('btnExport'),
  recordsBody: $('recordsBody'),
};

let state = { unlocked: false, network: 'mainnet', address: '' };
let type = 'trx';

function showError(msg) {
  ui.error.textContent = msg;
  ui.error.classList.remove('hidden');
}

function clearMessages() {
  ui.error.classList.add('hidden');
  ui.result.classList.add('hidden');
  ui.estimate.classList.add('hidden');
}

function fmt(n, digits = 6) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
}

function setBusy(busy) {
  [ui.btnUnlock, ui.btnLock, ui.btnRefresh, ui.btnEstimate, ui.btnSend, ui.network, ui.btnExport].forEach(
    (el) => {
      if (busy) {
        el.dataset.prev = el.disabled ? '1' : '0';
        el.disabled = true;
      } else {
        el.disabled = el.dataset.prev === '1';
        delete el.dataset.prev;
      }
    }
  );
  if (!busy) syncButtons();
}

function syncButtons() {
  ui.btnUnlock.disabled = state.unlocked;
  ui.btnLock.disabled = !state.unlocked;
  ui.btnRefresh.disabled = !state.unlocked;
  ui.btnEstimate.disabled = !state.unlocked;
  ui.btnSend.disabled = !state.unlocked;
  ui.netBadge.textContent = state.unlocked
    ? state.network === 'nile'
      ? 'Nile 测试网'
      : '主网'
    : '未解锁';
  ui.netBadge.classList.toggle('live', state.unlocked);
}

async function call(promiseLike) {
  const res = await promiseLike;
  if (!res || res.ok !== true) throw new Error((res && res.error) || '未知错误');
  return res.data;
}

async function refreshState() {
  const s = await call(window.api.state());
  state = { ...state, ...s };
  ui.network.value = s.network;
  ui.address.textContent = s.address || '—';
  syncButtons();
  if (s.unlocked) await refreshBalances();
}

async function refreshBalances() {
  if (!state.unlocked) return;
  try {
    const b = await call(window.api.balances());
    ui.trxBalance.textContent = fmt(b.trx, 6);
    ui.usdtBalance.textContent = fmt(b.usdt, 6);
  } catch (e) {
    showError('余额查询失败：' + e.message);
  }
}

async function loadRecords() {
  try {
    const list = await call(window.api.records());
    if (!list.length) {
      ui.recordsBody.innerHTML = '<tr><td colspan="7" class="empty">暂无记录</td></tr>';
      return;
    }
    ui.recordsBody.innerHTML = list
      .map((r) => {
        const time = new Date(r.time).toLocaleString('zh-CN', { hour12: false });
        const link = r.explorer
          ? `<a href="${r.explorer}" target="_blank" rel="noreferrer">${r.txid.slice(0, 10)}…</a>`
          : r.txid;
        return `<tr>
          <td>${time}</td>
          <td>${r.network === 'nile' ? 'Nile' : '主网'}</td>
          <td>${r.type.toUpperCase()}</td>
          <td class="mono">${r.to.slice(0, 8)}…${r.to.slice(-6)}</td>
          <td>${fmt(r.amount, 6)}</td>
          <td>${(r.memo || '').replace(/</g, '&lt;')}</td>
          <td>${link}</td>
        </tr>`;
      })
      .join('');
  } catch (e) {
    showError('记录读取失败：' + e.message);
  }
}

ui.network.addEventListener('change', async () => {
  clearMessages();
  try {
    setBusy(true);
    const r = await call(window.api.setNetwork(ui.network.value));
    state.network = r.network;
    state.address = r.address;
    ui.address.textContent = r.address || '—';
    syncButtons();
    if (state.unlocked) {
      await refreshBalances();
      showError('已切换网络，余额与费用均为新网络数据，请在测试网先验证');
    }
  } catch (e) {
    showError('切换网络失败：' + e.message);
  } finally {
    setBusy(false);
  }
});

ui.btnUnlock.addEventListener('click', async () => {
  clearMessages();
  const pk = ui.pk.value.trim();
  if (!pk) return showError('请输入私钥');
  try {
    setBusy(true);
    const r = await call(window.api.unlock(pk));
    ui.pk.value = '';
    state.unlocked = true;
    state.address = r.address;
    ui.address.textContent = r.address;
    syncButtons();
    await refreshBalances();
  } catch (e) {
    showError('解锁失败：' + e.message);
  } finally {
    setBusy(false);
  }
});

ui.btnLock.addEventListener('click', async () => {
  clearMessages();
  try {
    await call(window.api.lock());
    state.unlocked = false;
    state.address = '';
    ui.address.textContent = '—';
    ui.trxBalance.textContent = '—';
    ui.usdtBalance.textContent = '—';
    syncButtons();
  } catch (e) {
    showError('锁定失败：' + e.message);
  }
});

ui.btnRefresh.addEventListener('click', refreshBalances);

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    type = tab.dataset.type;
    clearMessages();
  });
});

function readForm() {
  const to = ui.to.value.trim();
  const amount = ui.amount.value.trim();
  const memo = ui.memo.value.trim();
  if (!to) throw new Error('请输入收款地址');
  if (!amount) throw new Error('请输入金额');
  return { type, to, amount, memo };
}

ui.btnEstimate.addEventListener('click', async () => {
  clearMessages();
  try {
    setBusy(true);
    const p = readForm();
    const est = await call(window.api.estimate(p));
    const parts = [
      `预估手续费：<strong>${fmt(est.feeTrx, 6)} TRX</strong>`,
      est.energy ? `能量：${est.energy.toLocaleString()} × ${est.energyFee} sun` : `带宽：约 ${est.bytes} 字节`,
      est.activateFee ? `含收款方激活费 ${est.activateFee} TRX` : '',
      est.note,
    ].filter(Boolean);
    if (est.warning) parts.push(`<span class="warn-line">${est.warning}</span>`);
    ui.estimate.innerHTML = parts.join('<br>');
    ui.estimate.classList.remove('hidden');
  } catch (e) {
    showError('预估失败：' + e.message);
  } finally {
    setBusy(false);
  }
});

ui.btnSend.addEventListener('click', async () => {
  clearMessages();
  let p;
  try {
    p = readForm();
  } catch (e) {
    return showError(e.message);
  }
  const netName = state.network === 'nile' ? 'Nile 测试网' : '主网';
  const ok = window.confirm(
    `确认在【${netName}】发送\n\n类型：${p.type.toUpperCase()}\n收款：${p.to}\n金额：${p.amount}\n备注：${
      p.memo || '无'
    }\n\n链上转账不可撤销，请核对地址。`
  );
  if (!ok) return;

  try {
    setBusy(true);
    const r = await call(window.api.send(p));
    ui.result.innerHTML = `已广播成功<br>txID：<span class="mono">${r.txid}</span><br>预估手续费：${fmt(
      r.estimatedFeeTrx,
      6
    )} TRX<br><a href="${r.explorer}" target="_blank" rel="noreferrer">在浏览器中查看</a>`;
    ui.result.classList.remove('hidden');
    ui.amount.value = '';
    await refreshBalances();
    await loadRecords();
  } catch (e) {
    showError('发送失败：' + e.message);
  } finally {
    setBusy(false);
  }
});

ui.btnExport.addEventListener('click', async () => {
  try {
    const r = await call(window.api.exportRecords());
    if (r.canceled) return;
    ui.result.textContent = `已导出 ${r.count} 条记录到 ${r.filePath}`;
    ui.result.classList.remove('hidden');
  } catch (e) {
    showError('导出失败：' + e.message);
  }
});

(async function init() {
  try {
    await refreshState();
  } catch (e) {
    showError('初始化失败：' + e.message);
  }
  await loadRecords();
})();
