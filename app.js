'use strict';

/* ---------------- 常量 ---------------- */

const HOSTS = {
  mainnet: 'https://api.trongrid.io',
  nile: 'https://nile.trongrid.io',
};

const EXPLORERS = {
  mainnet: 'https://tronscan.org',
  nile: 'https://nile.tronscan.org',
};

const USDT_CONTRACTS = {
  mainnet: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  nile: 'TS3EhDATvq7UG9cEQny4EczHWcdzavGndX',
};

const DEFAULT_NETWORK = 'nile';
const DEFAULT_ACCOUNTS = {
  nile: 'TLruhEuA2FYwWKHKvZGE6hijMYf6PD7nur',
};

const SUN = 1_000_000;
const MEMO_LIMIT = 900;
const DEFAULT_ENERGY_FEE = 420;
const DEFAULT_BANDWIDTH_FEE = 1000;
const DEFAULT_USDT_ENERGY = 65000;
const ACTIVATE_FEE = 1.1;
const RECORDS_KEY = 'tron_transfers_v1';
const RECORDS_LIMIT = 200;

const encoder = new TextEncoder();

const byteLength = (str) => encoder.encode(str).length;

const toHex = (str) =>
  Array.from(encoder.encode(str))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

async function fetchJson(url, options = {}, timeout = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- 钱包服务（浏览器端） ---------------- */

class WalletService {
  constructor(network = 'mainnet') {
    this.network = network;
    this.privateKey = null;
    this.tronWeb = null;
    this._energyFee = null;
    this._energyFeeAt = 0;
    this._bandwidthFee = DEFAULT_BANDWIDTH_FEE;
  }

  get host() {
    return HOSTS[this.network];
  }

  get usdtContract() {
    return USDT_CONTRACTS[this.network];
  }

  get unlocked() {
    return !!this.tronWeb;
  }

  get address() {
    return this.tronWeb ? this.tronWeb.defaultAddress.base58 : '';
  }

  setNetwork(network) {
    if (!HOSTS[network]) throw new Error('网络仅支持主网 / Nile 测试网');
    const expected = DEFAULT_ACCOUNTS[network];
    if (this.privateKey && expected && this.address !== expected) {
      throw new Error(`当前私钥不是 Nile 默认账户 ${expected}`);
    }
    this.network = network;
    this._energyFee = null;
    if (this.privateKey) this._initTron();
    return { network: this.network, address: this.address };
  }

  unlock(privateKey) {
    const key = String(privateKey || '')
      .trim()
      .replace(/^0x/, '');
    if (!/^[0-9a-fA-F]{64}$/.test(key)) {
      throw new Error('私钥格式不正确：需 64 位十六进制字符串');
    }
    this.privateKey = key;
    this._initTron();
    const expected = DEFAULT_ACCOUNTS[this.network];
    if (expected && this.address !== expected) {
      this.lock();
      throw new Error(`私钥与 Nile 默认账户不匹配，应为 ${expected}`);
    }
    return this.address;
  }

  lock() {
    this.privateKey = null;
    this.tronWeb = null;
  }

  _initTron() {
    this.tronWeb = new window.TronWeb({ fullHost: this.host, privateKey: this.privateKey });
  }

  _requireUnlocked() {
    if (!this.tronWeb) throw new Error('尚未解锁钱包，请先输入私钥');
  }

  async _usdtBalanceRaw() {
    const res = await this.tronWeb.transactionBuilder.triggerConstantContract(
      this.usdtContract,
      'balanceOf(address)',
      {},
      [{ type: 'address', value: this.address }],
      this.address
    );
    const hex = (res.constant_result && res.constant_result[0]) || '0';
    return BigInt('0x' + (hex || '0'));
  }

  async getBalances() {
    this._requireUnlocked();
    const trxSun = await this.tronWeb.trx.getBalance(this.address);
    let usdt = 0;
    try {
      usdt = Number(await this._usdtBalanceRaw()) / 1e6;
    } catch (_) {
      /* USDT 查询失败不影响 TRX 展示 */
    }
    return { trx: trxSun / SUN, usdt };
  }

  async _isActivated(addr) {
    try {
      const acc = await this.tronWeb.trx.getAccount(addr);
      return !!(acc && (acc.address || acc.balance !== undefined));
    } catch (_) {
      return true;
    }
  }

  async _getEnergyFee() {
    const ttl = 10 * 60 * 1000;
    if (this._energyFee && Date.now() - this._energyFeeAt < ttl) return this._energyFee;
    try {
      const data = await fetchJson(`${this.host}/wallet/getchainparameters`);
      const list = (data && data.chainParameter) || [];
      const ef = list.find((x) => x.key === 'getEnergyFee');
      const bf = list.find((x) => x.key === 'getTransactionFee');
      this._energyFee = ef && ef.value ? Number(ef.value) : DEFAULT_ENERGY_FEE;
      if (bf && bf.value) this._bandwidthFee = Number(bf.value);
    } catch (_) {
      this._energyFee = this._energyFee || DEFAULT_ENERGY_FEE;
    }
    this._energyFeeAt = Date.now();
    return this._energyFee;
  }

  async _estimateUsdtEnergy(to, amountRaw) {
    const built = await this.tronWeb.transactionBuilder.triggerSmartContract(
      this.usdtContract,
      'transfer(address,uint256)',
      { feeLimit: 100 * SUN },
      [
        { type: 'address', value: to },
        { type: 'uint256', value: amountRaw },
      ],
      this.address
    );
    const tx = built.transaction;
    let parameter = '';
    try {
      parameter = tx.raw_data.contract[0].parameter.value.data.slice(8);
    } catch (_) {
      /* ignore */
    }
    if (!parameter) return DEFAULT_USDT_ENERGY;
    try {
      const data = await fetchJson(`${this.host}/wallet/estimateenergy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          owner_address: this.address,
          contract_address: this.usdtContract,
          function_selector: 'transfer(address,uint256)',
          parameter,
          visible: true,
        }),
      });
      return data && data.energy_required ? Number(data.energy_required) : DEFAULT_USDT_ENERGY;
    } catch (_) {
      return DEFAULT_USDT_ENERGY;
    }
  }

  async estimate({ type, to, amount, memo }) {
    this._requireUnlocked();
    if (!this.tronWeb.isAddress(to)) throw new Error('收款地址格式不正确');
    if (to === this.address) throw new Error('不能向自己转账');

    const val = Number(amount);
    if (!Number.isFinite(val) || val <= 0) throw new Error('金额必须大于 0');
    if (memo) WalletService.validateMemo(memo);

    const activated = await this._isActivated(to);
    const activateFee = activated ? 0 : ACTIVATE_FEE;

    if (type === 'trx') {
      const amountSun = Math.round(val * SUN);
      if (amountSun < 1) throw new Error('TRX 金额过小');
      let bytes = 280;
      try {
        const tx = await this.tronWeb.transactionBuilder.sendTrx(to, amountSun, this.address);
        bytes = Math.ceil(tx.raw_data_hex.length / 2);
      } catch (_) {
        /* 离线时用估算字节数 */
      }
      const memoSun = memo ? byteLength(memo) : 0;
      const bandwidthSun = (bytes + 64 + memoSun) * this._bandwidthFee;
      const feeTrx = bandwidthSun / SUN + activateFee;
      const trxSun = await this.tronWeb.trx.getBalance(this.address);
      const needSun = amountSun + Math.round(feeTrx * SUN);
      const warning =
        trxSun < needSun
          ? `TRX 余额不足：需要约 ${(needSun / SUN).toFixed(6)}，当前 ${(trxSun / SUN).toFixed(6)}`
          : '';
      return {
        type,
        amount: val,
        bytes: bytes + 64 + memoSun,
        energy: 0,
        feeTrx,
        activateFee,
        warning,
        note: '有免费带宽时不扣费；无免费带宽时按字节计费',
      };
    }

    const amountRaw = BigInt(Math.round(val * 1e6)).toString();
    const energy = await this._estimateUsdtEnergy(to, amountRaw);
    const energyFee = await this._getEnergyFee();
    const feeTrx = (energy * energyFee) / SUN + 0.35 + activateFee;
    let warning = '';
    try {
      const bal = await this._usdtBalanceRaw();
      if (bal < BigInt(amountRaw)) warning = `USDT 余额不足：当前 ${Number(bal) / 1e6}`;
    } catch (_) {
      /* 查询失败时不阻断预估 */
    }
    return {
      type,
      amount: val,
      bytes: 0,
      energy,
      energyFee,
      feeTrx,
      activateFee,
      warning,
      note: '按链上基础能量单价估算；主网动态能量系数通常使实际扣费高于此值，建议多留 TRX',
    };
  }

  static validateMemo(memo) {
    const bytes = byteLength(memo);
    if (bytes > MEMO_LIMIT) throw new Error(`备注超过 ${MEMO_LIMIT} 字节（当前 ${bytes}）`);
  }

  async send({ type, to, amount, memo }) {
    this._requireUnlocked();
    const est = await this.estimate({ type, to, amount, memo });

    if (type === 'trx') {
      const bal = await this.tronWeb.trx.getBalance(this.address);
      if (bal < Math.round(Number(amount) * SUN)) {
        throw new Error(`TRX 余额不足：当前 ${(bal / SUN).toFixed(6)}`);
      }
    } else {
      const bal = await this._usdtBalanceRaw();
      if (bal < BigInt(Math.round(Number(amount) * 1e6))) {
        throw new Error(`USDT 余额不足：当前 ${Number(bal) / 1e6}`);
      }
    }

    const memoHex = memo ? toHex(memo) : '';
    let tx;

    if (type === 'trx') {
      const amountSun = Math.round(Number(amount) * SUN);
      tx = await this.tronWeb.transactionBuilder.sendTrx(to, amountSun, this.address);
    } else {
      const amountRaw = BigInt(Math.round(Number(amount) * 1e6)).toString();
      const built = await this.tronWeb.transactionBuilder.triggerSmartContract(
        this.usdtContract,
        'transfer(address,uint256)',
        { feeLimit: 100 * SUN },
        [
          { type: 'address', value: to },
          { type: 'uint256', value: amountRaw },
        ],
        this.address
      );
      if (!built.result || !built.result.result) {
        throw new Error('构造 USDT 转账失败：' + JSON.stringify(built.result || {}).slice(0, 200));
      }
      tx = built.transaction;
    }

    const txid = await this._signAndBroadcast(tx, memoHex);
    return {
      txid,
      explorer: `${EXPLORERS[this.network]}/#/transaction/${txid}`,
      estimatedFeeTrx: est.feeTrx,
    };
  }

  async _signAndBroadcast(tx, memoHex) {
    if (memoHex) {
      tx.raw_data = tx.raw_data || {};
      tx.raw_data.data = memoHex;
      // TronWeb 5 不会因 raw_data 变化自动重算，必须手动重建
      const pb = this.tronWeb.utils.transaction.txJsonToPb(tx);
      tx.raw_data_hex = this.tronWeb.utils.transaction.txPbToRawDataHex(pb).toLowerCase();
      tx.txID = this.tronWeb.utils.transaction.txPbToTxID(pb).replace(/^0x/, '');
    }
    const signed = await this.tronWeb.trx.sign(tx, this.privateKey);
    const res = await this.tronWeb.trx.sendRawTransaction(signed);
    if (!res || !res.result) {
      throw new Error('广播失败：' + JSON.stringify(res || {}).slice(0, 300));
    }
    return res.txid || signed.txID;
  }
}

/* ---------------- 本地记录 ---------------- */

function loadRecords() {
  try {
    const raw = localStorage.getItem(RECORDS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch (_) {
    return [];
  }
}

function saveRecord(record) {
  const list = loadRecords();
  list.unshift(record);
  try {
    localStorage.setItem(RECORDS_KEY, JSON.stringify(list.slice(0, RECORDS_LIMIT)));
  } catch (_) {
    /* 存储满时忽略，不影响转账 */
  }
}

/* ---------------- UI ---------------- */

const $ = (id) => document.getElementById(id);

const ui = {
  network: $('network'),
  netBadge: $('netBadge'),
  pk: $('pk'),
  pkHint: $('pkHint'),
  btnUnlock: $('btnUnlock'),
  btnLock: $('btnLock'),
  btnRefresh: $('btnRefresh'),
  address: $('address'),
  trxBalance: $('trxBalance'),
  usdtBalance: $('usdtBalance'),
  usdtLabel: $('usdtLabel'),
  usdtTab: $('usdtTab'),
  usdtNotice: $('usdtNotice'),
  to: $('to'),
  amount: $('amount'),
  memo: $('memo'),
  btnEstimate: $('btnEstimate'),
  btnSend: $('btnSend'),
  estimate: $('estimate'),
  result: $('result'),
  error: $('error'),
  btnExport: $('btnExport'),
  recordsList: $('recordsList'),
};

const wallet = new WalletService(DEFAULT_NETWORK);
let state = { unlocked: false, network: DEFAULT_NETWORK, address: '' };
let type = 'trx';

function fmt(n, digits = 6) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
}

function showError(msg) {
  ui.error.textContent = msg;
  ui.error.classList.remove('hidden');
}

function showSuccess(html) {
  ui.result.innerHTML = html;
  ui.result.classList.remove('hidden');
}

function clearMessages() {
  [ui.error, ui.result, ui.estimate].forEach((el) => el.classList.add('hidden'));
}

function setBusy(busy) {
  const els = [
    ui.btnUnlock,
    ui.btnLock,
    ui.btnRefresh,
    ui.btnEstimate,
    ui.btnSend,
    ui.network,
    ui.btnExport,
  ];
  els.forEach((el) => {
    if (busy) {
      el.dataset.prev = el.disabled ? '1' : '0';
      el.disabled = true;
    } else {
      el.disabled = el.dataset.prev === '1';
      delete el.dataset.prev;
    }
  });
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
  const customNileUsdt = state.network === 'nile';
  ui.usdtLabel.textContent = customNileUsdt ? '测试 USDT' : 'USDT';
  ui.usdtTab.textContent = customNileUsdt ? '测试 USDT' : 'USDT';
  ui.usdtNotice.classList.toggle('hidden', !customNileUsdt);
  const defaultAccount = DEFAULT_ACCOUNTS[state.network];
  ui.pkHint.textContent = defaultAccount
    ? `默认账户 ${defaultAccount.slice(0, 8)}…${defaultAccount.slice(-4)}，需输入该地址私钥；刷新即清除。`
    : '仅保存在页面内存，刷新即清除。';
}

async function refreshBalances() {
  if (!state.unlocked) return;
  try {
    const b = await wallet.getBalances();
    ui.trxBalance.textContent = fmt(b.trx, 6);
    ui.usdtBalance.textContent = fmt(b.usdt, 6);
  } catch (e) {
    showError('余额查询失败：' + e.message);
  }
}

function renderRecords() {
  const list = loadRecords();
  if (!list.length) {
    ui.recordsList.innerHTML = '<li class="empty">暂无记录</li>';
    return;
  }
  ui.recordsList.innerHTML = list
    .map((r) => {
      const time = new Date(r.time).toLocaleString('zh-CN', { hour12: false });
      const shortTo = r.to.length > 16 ? `${r.to.slice(0, 8)}…${r.to.slice(-6)}` : r.to;
      const memo = (r.memo || '').replace(/</g, '&lt;');
      const link = r.explorer
        ? `<a href="${r.explorer}" target="_blank" rel="noreferrer">${r.txid.slice(0, 10)}…</a>`
        : r.txid;
      return `<li>
        <div class="rec-top">
          <span>${r.type.toUpperCase()} · ${r.network === 'nile' ? 'Nile' : '主网'}</span>
          <span class="rec-amount">${fmt(r.amount, 6)}</span>
        </div>
        <div class="rec-sub">${time} → <span class="mono">${shortTo}</span></div>
        ${memo ? `<div class="rec-sub">备注：${memo}</div>` : ''}
        <div class="rec-sub">交易：${link}</div>
      </li>`;
    })
    .join('');
}

/* ---------------- 事件 ---------------- */

ui.network.addEventListener('change', async () => {
  clearMessages();
  try {
    setBusy(true);
    const r = wallet.setNetwork(ui.network.value);
    state.network = r.network;
    state.address = r.address;
    ui.address.textContent = r.address || '—';
    syncButtons();
    if (state.unlocked) {
      await refreshBalances();
      showError('已切换网络，余额与费用均为新网络数据，请先在测试网验证');
    }
  } catch (e) {
    ui.network.value = state.network;
    showError(e.message);
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
    state.address = wallet.unlock(pk);
    ui.pk.value = '';
    state.unlocked = true;
    ui.address.textContent = state.address;
    syncButtons();
    await refreshBalances();
  } catch (e) {
    showError('解锁失败：' + e.message);
  } finally {
    setBusy(false);
  }
});

ui.btnLock.addEventListener('click', () => {
  clearMessages();
  wallet.lock();
  state.unlocked = false;
  state.address = '';
  ui.address.textContent = '—';
  ui.trxBalance.textContent = '—';
  ui.usdtBalance.textContent = '—';
  syncButtons();
});

ui.btnRefresh.addEventListener('click', async () => {
  clearMessages();
  try {
    setBusy(true);
    await refreshBalances();
  } finally {
    setBusy(false);
  }
});

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
    const est = await wallet.estimate(readForm());
    const parts = [
      `预估手续费：<strong>${fmt(est.feeTrx, 6)} TRX</strong>`,
      est.energy
        ? `能量：${est.energy.toLocaleString()} × ${est.energyFee} sun`
        : `带宽：约 ${est.bytes} 字节`,
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
    `确认在【${netName}】发送\n\n类型：${p.type === 'usdt' && state.network === 'nile' ? '自定义测试 USDT' : p.type.toUpperCase()}\n收款：${p.to}\n金额：${
      p.amount
    }\n备注：${p.memo || '无'}\n\n链上转账不可撤销，请核对地址。`
  );
  if (!ok) return;

  try {
    setBusy(true);
    const r = await wallet.send(p);
    showSuccess(
      `已广播成功<br>txID：<span class="mono">${r.txid}</span><br>预估手续费：${fmt(
        r.estimatedFeeTrx,
        6
      )} TRX<br><a href="${r.explorer}" target="_blank" rel="noreferrer">在区块浏览器查看</a>`
    );
    saveRecord({
      time: Date.now(),
      network: state.network,
      type: p.type,
      to: p.to,
      amount: Number(p.amount),
      memo: p.memo,
      txid: r.txid,
      explorer: r.explorer,
    });
    ui.amount.value = '';
    await refreshBalances();
    renderRecords();
  } catch (e) {
    showError('发送失败：' + e.message);
  } finally {
    setBusy(false);
  }
});

ui.btnExport.addEventListener('click', () => {
  const list = loadRecords();
  if (!list.length) return showError('暂无记录可导出');
  const header = ['时间', '网络', '类型', '接收方', '金额', '备注', 'txID', '浏览器链接'];
  const rows = list.map((r) => [
    new Date(r.time).toLocaleString('zh-CN', { hour12: false }),
    r.network === 'nile' ? 'Nile' : '主网',
    r.type.toUpperCase(),
    r.to,
    r.amount,
    r.memo || '',
    r.txid,
    r.explorer || '',
  ]);
  const escape = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const csv = '\ufeff' + [header, ...rows].map((row) => row.map(escape).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tron-transfers-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

/* ---------------- 初始化 ---------------- */

(function init() {
  if (!window.TronWeb) {
    showError('TronWeb 加载失败，请检查 vendor/tronweb.js 是否存在');
    return;
  }
  syncButtons();
  renderRecords();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
})();
