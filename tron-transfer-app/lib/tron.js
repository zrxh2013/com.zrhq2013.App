'use strict';

const axios = require('axios');
const TronWebModule = require('tronweb');
// tronweb 5 直接导出构造函数，旧版本/ESM 包装可能挂在 TronWeb 或 default 上
const TronWeb = TronWebModule.TronWeb || TronWebModule.default || TronWebModule;

const HOSTS = {
  mainnet: 'https://api.trongrid.io',
  nile: 'https://nile.trongrid.io',
};

// 官方 USDT（TRC20）合约；Nile 上为测试用 USDT 合约
const USDT_CONTRACTS = {
  mainnet: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  nile: 'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj',
};

const SUN = 1_000_000;
const MEMO_LIMIT = 900; // 字节
const DEFAULT_ENERGY_FEE = 420; // sun / energy
const DEFAULT_BANDWIDTH_FEE = 1000; // sun / byte
const DEFAULT_USDT_ENERGY = 65000;
const ACTIVATE_FEE = 1.1; // TRX，收款方未激活时

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
    if (!HOSTS[network]) throw new Error('网络仅支持 mainnet / nile');
    this.network = network;
    this._energyFee = null;
    if (this.privateKey) this._initTron();
    return { network: this.network, address: this.address };
  }

  unlock(privateKey) {
    const key = String(privateKey || '').trim().replace(/^0x/, '');
    if (!/^[0-9a-fA-F]{64}$/.test(key)) {
      throw new Error('私钥格式不正确：需 64 位十六进制字符串');
    }
    this.privateKey = key;
    this._initTron();
    return this.address;
  }

  lock() {
    this.privateKey = null;
    this.tronWeb = null;
  }

  _initTron() {
    this.tronWeb = new TronWeb({ fullHost: this.host, privateKey: this.privateKey });
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
      // USDT 查询失败不影响 TRX 余额展示
    }
    return { trx: trxSun / SUN, usdt };
  }

  async _isActivated(addr) {
    try {
      const acc = await this.tronWeb.trx.getAccount(addr);
      return !!(acc && (acc.address || acc.balance !== undefined));
    } catch (_) {
      return true; // 查询失败时不额外加激活费，避免误导
    }
  }

  async _getEnergyFee() {
    const ttl = 10 * 60 * 1000;
    if (this._energyFee && Date.now() - this._energyFeeAt < ttl) return this._energyFee;
    try {
      const r = await axios.get(`${this.host}/wallet/getchainparameters`, { timeout: 15000 });
      const list = (r.data && r.data.chainParameter) || [];
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
      const data = tx.raw_data.contract[0].parameter.value.data;
      parameter = data.slice(8);
    } catch (_) {
      /* ignore */
    }
    if (!parameter) return DEFAULT_USDT_ENERGY;
    try {
      const r = await axios.post(
        `${this.host}/wallet/estimateenergy`,
        {
          owner_address: this.address,
          contract_address: this.usdtContract,
          function_selector: 'transfer(address,uint256)',
          parameter,
          visible: true,
        },
        { timeout: 15000 }
      );
      const e = r.data && r.data.energy_required;
      return e ? Number(e) : DEFAULT_USDT_ENERGY;
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
    if (memo) this._validateMemo(memo);

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
      const memoSun = memo ? Buffer.byteLength(memo, 'utf8') : 0;
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

    // USDT
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

  _validateMemo(memo) {
    const bytes = Buffer.byteLength(memo, 'utf8');
    if (bytes > MEMO_LIMIT) throw new Error(`备注超过 ${MEMO_LIMIT} 字节（当前 ${bytes}）`);
  }

  async send({ type, to, amount, memo }) {
    this._requireUnlocked();
    const est = await this.estimate({ type, to, amount, memo });

    // 广播前硬校验余额，避免 USDT 合约 revert 仍消耗能量
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

    const memoHex = memo ? Buffer.from(memo, 'utf8').toString('hex') : '';

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
      explorer:
        (this.network === 'nile' ? 'https://nile.tronscan.org' : 'https://tronscan.org') +
        `/#/transaction/${txid}`,
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

module.exports = { WalletService, HOSTS, USDT_CONTRACTS };
