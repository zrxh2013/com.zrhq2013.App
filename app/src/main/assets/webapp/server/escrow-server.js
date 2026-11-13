/* ============================================================
 * 信托公证提存 · TRON 链上提存服务
 *  - 静态托管 webapp（同源部署，前端直接调用 /api/*）
 *  - 只读：余额查询、交易确认（无需私钥）
 *  - 签名：memo 锚定 / TRX 转账 / USDT(TRC20) 转账
 * 安全：私钥仅从环境变量 TRON_PRIVATE_KEY 读取，不记录、不下发
 * 启动：PORT=8899 TRON_NETWORK=mainnet node server/escrow-server.js
 * ============================================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8899);
const ROOT = path.resolve(__dirname, '..');
const SUN = 1_000_000;
const BURN_ADDRESS = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
const TRON_NETWORK = process.env.TRON_NETWORK === 'nile' ? 'nile' : 'mainnet';

const NETWORKS = {
  mainnet: { fullHost: 'https://api.trongrid.io', usdtContract: process.env.USDT_CONTRACT_MAINNET || 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' },
  nile: { fullHost: 'https://nile.trongrid.io', usdtContract: process.env.USDT_CONTRACT_NILE || '' }
};

let TronWeb = null;
try { ({ TronWeb } = require('tronweb')); }
catch { console.warn('[warn] 未安装 tronweb，签名接口不可用（npm install 后重启）'); }

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.map': 'application/json'
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 96 * 1024) { reject(new Error('请求体超过 96KB 限制')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

const isValidT = (a) => typeof a === 'string' && /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a);
const isHex = (h) => typeof h === 'string' && /^[0-9a-fA-F]*$/.test(h) && h.length % 2 === 0 && h.length <= 1800;

function getTron(network) {
  if (!TronWeb) throw Object.assign(new Error('服务器未安装 tronweb，请先 npm install'), { code: 'NO_TRONWEB' });
  const cfg = NETWORKS[network] || NETWORKS[TRON_NETWORK];
  const key = process.env.TRON_PRIVATE_KEY;
  if (!key) throw Object.assign(new Error('未配置 TRON_PRIVATE_KEY 环境变量，签名接口禁用（只读模式）'), { code: 'KEY_MISSING' });
  return new TronWeb({ fullHost: cfg.fullHost, privateKey: key });
}

/* 手动序列化带 memo(data) 的 TransferContract 并签名。
 * 原因：tronweb 6.5.x 的 sendTrx 的 getTransactionOptions 只提取 blockHeader，
 *       丢弃 options.data；且 TransferContract proto 没有 data 字段。
 * 方案：借用 sendTrx 取区块引用，手动按 TRON 官方 proto 重序列化，
 *       memo 写入 raw_data.data（field 10，tag 0x52），而非 TransferContract。
 *       用 sha256 重算 txID，再用 crypto.signTransaction 直接对 txID 签名。
 * 无 memo 时输出与 tronweb 逐字节一致。 */
async function buildSignedTransferTx(tw, to, amountSun, memoHex) {
  const encVarint = (n) => { let v = BigInt(n); const out = []; while (v >= 0x80n) { out.push(Number(v & 0x7fn) | 0x80); v >>= 7n; } out.push(Number(v)); return Buffer.from(out); };
  const encBytes = (tag, buf) => Buffer.concat([Buffer.from([tag]), encVarint(buf.length), buf]);
  const encVarintField = (tag, n) => Buffer.concat([Buffer.from([tag]), encVarint(n)]);
  const fromHex = (s) => Buffer.from(String(s).replace(/^0x/, ''), 'hex');

  const baseTx = await tw.transactionBuilder.sendTrx(to, amountSun);
  const r = baseTx.raw_data;
  const v = baseTx.raw_data.contract[0].parameter.value;

  // TransferContract: owner_address(1) / to_address(2) / amount(3) — 无 data 字段
  const transfer = Buffer.concat([
    encBytes(0x0a, fromHex(v.owner_address)),
    encBytes(0x12, fromHex(v.to_address)),
    encVarintField(0x18, v.amount),
  ]);

  const typeUrl = Buffer.from('type.googleapis.com/protocol.TransferContract', 'utf8');
  const any = Buffer.concat([encBytes(0x0a, typeUrl), encBytes(0x12, transfer)]);
  const contract = Buffer.concat([encVarintField(0x08, 1), encBytes(0x12, any)]);

  // raw_data: ref_block_bytes(1) / ref_block_hash(4) / expiration(8) / data(10) / contract(11) / timestamp(14)
  const rawParts = [
    encBytes(0x0a, fromHex(r.ref_block_bytes)),
    encBytes(0x22, fromHex(r.ref_block_hash)),
    encVarintField(0x40, r.expiration),
  ];
  if (memoHex) rawParts.push(encBytes(0x52, fromHex(memoHex))); // field 10 = data, tag 0x52
  rawParts.push(encBytes(0x5a, contract));
  rawParts.push(encVarintField(0x70, r.timestamp));
  const rawData = Buffer.concat(rawParts);

  const raw_data_hex = rawData.toString('hex');
  const txID = tw.utils.ethersUtils.sha256(rawData).replace(/^0x/, '');
  const signedObj = tw.utils.crypto.signTransaction(process.env.TRON_PRIVATE_KEY.replace(/^0x/, ''), { txID });

  baseTx.txID = txID;
  baseTx.raw_data_hex = raw_data_hex;
  baseTx.signature = signedObj.signature;
  if (memoHex) baseTx.raw_data.data = memoHex.toLowerCase(); // 仅用于 JSON 自省
  return baseTx;
}

/* ============================================================
 * 模拟区块链钱包（SIMCHAIN · 本地演示专用）
 * 边界声明：
 *  - 不连接任何真实 TRON 节点，不产生真实交易，不具链上存证法律效力
 *  - 所有 txID 由本地 sha256 生成，记录一律带 simulated 标记，绝不返回 tronscan 链接
 *  - 状态持久化到 server/.mock-chain.json（gitignore，权限 600），支持一键重置
 * ============================================================ */
const MOCK_STATE_FILE = path.join(__dirname, '.mock-chain.json');
const MOCK_CHAIN_ID = 'SIMCHAIN-LOCAL';
const MOCK_FEE_SUN = 1000;

function loadMockState() {
  try { return JSON.parse(fs.readFileSync(MOCK_STATE_FILE, 'utf8')); }
  catch { return null; }
}
function saveMockState() {
  try {
    fs.writeFileSync(MOCK_STATE_FILE, JSON.stringify(mock.state, null, 2));
    fs.chmodSync(MOCK_STATE_FILE, 0o600);
  } catch (e) { console.warn('[mock] 状态持久化失败:', e.message); }
}
function genMockPair(label) {
  if (!TronWeb) throw Object.assign(new Error('tronweb 未安装，模拟钱包不可用'), { code: 'NO_TRONWEB' });
  const r = TronWeb.createRandom();
  const address = typeof r.address === 'string' ? r.address : r.address.base58; // tronweb 6.x 返回字符串，旧版返回 {base58}
  return { label, address, key: r.privateKey.replace(/^0x/, ''), createdAt: Date.now() };
}

const mock = {
  state: loadMockState() || { chainId: MOCK_CHAIN_ID, height: 0, seq: 0, signer: null, wallet: null, accounts: {}, txs: {} },
  pair(kind) {
    if (!this.state[kind]) { this.state[kind] = genMockPair(kind); saveMockState(); }
    return this.state[kind];
  },
  ensureAccount(addr) {
    if (!this.state.accounts[addr]) this.state.accounts[addr] = { balanceSun: 0, createdAt: Date.now() };
    return this.state.accounts[addr];
  },
  balance(addr) { return (this.state.accounts[addr] && this.state.accounts[addr].balanceSun) || 0; },
  faucet(addr, amountSun) {
    if (!isValidT(addr)) throw new Error('地址格式不正确');
    if (!Number.isInteger(amountSun) || amountSun <= 0 || amountSun > 100_000_000 * SUN) throw new Error('模拟充值金额非法（须为 0~1 亿之间的正数 TRX）');
    const acc = this.ensureAccount(addr);
    acc.balanceSun += amountSun;
    saveMockState();
    return { simulated: true, address: addr, balanceSun: acc.balanceSun, balanceTrx: acc.balanceSun / SUN };
  },
  nextTxId(parts) {
    this.state.seq += 1;
    return crypto.createHash('sha256')
      .update(this.state.seq + '|' + parts.join('|') + '|' + Date.now() + '|' + crypto.randomBytes(8).toString('hex'))
      .digest('hex');
  },
  submit({ from, to, amountSun, memoHex, kind, token }) {
    if (!isValidT(from) || !isValidT(to)) throw new Error('地址格式不正确');
    const sender = this.ensureAccount(from);
    this.ensureAccount(to);
    const fee = kind === 'ANCHOR' ? 0 : MOCK_FEE_SUN;
    const need = amountSun + fee;
    if (sender.balanceSun < need) {
      throw Object.assign(new Error(`模拟钱包余额不足：需 ${need / SUN} TRX，当前 ${sender.balanceSun / SUN} TRX，请先领取模拟测试币`), { code: 'MOCK_INSUFFICIENT' });
    }
    sender.balanceSun -= need;
    this.state.accounts[to].balanceSun += amountSun;
    this.state.height += 1;
    const txID = this.nextTxId([from, to, String(amountSun), memoHex || '', kind]);
    const ts = Date.now();
    let memoText = null;
    if (memoHex) { try { memoText = Buffer.from(memoHex, 'hex').toString('utf8'); } catch { memoText = null; } }
    const rec = {
      txID, simulated: true, network: 'mock', chainId: MOCK_CHAIN_ID,
      blockNumber: this.state.height, timestamp: ts, blockTime: ts,
      from, to, amountSun, feeSun: fee, token: token || 'TRX',
      kind, memoHex: memoHex || null, memoText,
      contractRet: 'SUCCESS', confirmed: true, confirmations: 1
    };
    this.state.txs[txID] = rec;
    saveMockState();
    return rec;
  },
  tx(hash) {
    const rec = this.state.txs[hash];
    if (!rec) throw Object.assign(new Error('模拟链上未找到该交易'), { code: 'MOCK_TX_NOT_FOUND' });
    return { ...rec, confirmations: this.state.height - rec.blockNumber + 1 };
  },
  transactions(addr) {
    return Object.values(this.state.txs)
      .filter((t) => !addr || t.from === addr || t.to === addr)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 50);
  },
  reset() {
    this.state = { chainId: MOCK_CHAIN_ID, height: 0, seq: 0, signer: null, wallet: null, accounts: {}, txs: {} };
    this.pair('signer'); this.pair('wallet');
    this.faucet(this.state.signer.address, 10000 * SUN);
    saveMockState();
    return this.overview();
  },
  overview() {
    const signer = this.pair('signer');
    const wallet = this.pair('wallet');
    if (this.balance(signer.address) === 0 && this.state.height === 0) this.faucet(signer.address, 10000 * SUN);
    return {
      chainId: MOCK_CHAIN_ID, simulated: true, height: this.state.height,
      signer: { address: signer.address, balanceSun: this.balance(signer.address), balanceTrx: this.balance(signer.address) / SUN },
      wallet: { address: wallet.address, balanceSun: this.balance(wallet.address), balanceTrx: this.balance(wallet.address) / SUN }
    };
  }
};

async function apiBalance(url) {
  const address = url.searchParams.get('address') || '';
  const network = url.searchParams.get('network') || TRON_NETWORK;
  if (!isValidT(address)) throw new Error('地址格式不正确');
  if (network === 'mock') {
    const sun = mock.balance(address);
    return { address, network: 'mock', simulated: true, balanceSun: sun, balanceTrx: sun / SUN };
  }
  const tw = new TronWeb({ fullHost: (NETWORKS[network] || NETWORKS.mainnet).fullHost });
  const acc = await tw.trx.getAccount(address);
  return { address, network, balanceSun: acc.balance || 0, balanceTrx: (acc.balance || 0) / SUN };
}

async function apiMockAnchor(body) {
  if (!isHex(body.memoHex)) throw new Error('memoHex 非法（须为偶数长度十六进制，≤900 字节）');
  const from = mock.pair('signer').address;
  const rec = mock.submit({ from, to: BURN_ADDRESS, amountSun: 1, memoHex: body.memoHex.toLowerCase(), kind: 'ANCHOR' });
  return { txid: rec.txID, burn: BURN_ADDRESS, network: 'mock', simulated: true, explorer: null, block: rec.blockNumber };
}

async function apiMockTransfer(body) {
  const { to, amountSun, token } = body;
  if (!isValidT(to)) throw new Error('收款地址格式不正确');
  if (!Number.isInteger(amountSun) || amountSun <= 0) throw new Error('amountSun 须为正整数');
  if (body.memoHex && !isHex(body.memoHex)) throw new Error('memoHex 非法');
  if (token && token.startsWith('USDT')) throw new Error('模拟链当前仅支持 TRX 模拟提存，USDT 请在真实网络演练');
  const from = mock.pair('signer').address;
  const rec = mock.submit({ from, to, amountSun, memoHex: body.memoHex ? body.memoHex.toLowerCase() : null, kind: 'TRANSFER', token: 'TRX' });
  return { txid: rec.txID, token: 'TRX', to, amountSun, network: 'mock', simulated: true, explorer: null, block: rec.blockNumber };
}

async function apiAnchor(body) {
  const network = body.network || TRON_NETWORK;
  if (network === 'mock') return apiMockAnchor(body);
  if (!isHex(body.memoHex)) throw new Error('memoHex 非法（须为偶数长度十六进制，≤900 字节）');
  const tw = getTron(network);
  const signed = await buildSignedTransferTx(tw, BURN_ADDRESS, 1, body.memoHex.toLowerCase());
  const r = await tw.trx.sendRawTransaction(signed);
  if (!r.result) throw new Error('锚定交易广播被节点拒绝: ' + JSON.stringify(r));
  return { txid: r.txid, burn: BURN_ADDRESS, network, explorer: (network === 'nile' ? 'https://nile.tronscan.org/#/transaction/' : 'https://tronscan.io/#/transaction/') + r.txid };
}

async function apiTransfer(body) {
  const network = body.network || TRON_NETWORK;
  if (network === 'mock') return apiMockTransfer(body);
  const { to, amountSun, token } = body;
  if (!isValidT(to)) throw new Error('收款地址格式不正确');
  if (!Number.isInteger(amountSun) || amountSun <= 0) throw new Error('amountSun 须为正整数');
  if (body.memoHex && !isHex(body.memoHex)) throw new Error('memoHex 非法');
  const tw = getTron(network);
  const cfg = NETWORKS[network];

  if (token && token.startsWith('USDT')) {
    if (!cfg.usdtContract) throw new Error('该网络未配置 USDT 合约地址（设置 USDT_CONTRACT_NILE 环境变量）；memo 请改用 /api/anchor 单独锚定');
    const contract = await tw.contract().at(cfg.usdtContract);
    const result = await contract.transfer(to, amountSun).send();
    const txid = typeof result === 'string' ? result : result.txid;
    return { txid, token, to, amountSun, network, note: 'TRC20 标准转账不携带 memo，文书指纹请通过 /api/anchor 锚定' };
  }

  const signed = await buildSignedTransferTx(tw, to, amountSun, body.memoHex ? body.memoHex.toLowerCase() : undefined);
  const r = await tw.trx.sendRawTransaction(signed);
  if (!r.result) throw new Error('提存交易广播被节点拒绝: ' + JSON.stringify(r));
  return { txid: r.txid, token: 'TRX', to, amountSun, network, explorer: (network === 'nile' ? 'https://nile.tronscan.org/#/transaction/' : 'https://tronscan.io/#/transaction/') + r.txid };
}

async function apiTxInfo(hash, network) {
  if (!/^[0-9a-fA-F]{64}$/.test(hash)) throw new Error('交易哈希须为 64 位十六进制');
  if (network === 'mock') {
    const rec = mock.tx(hash);
    return {
      hash, network: 'mock', simulated: true,
      block: rec.blockNumber, confirmed: true,
      feeSun: rec.feeSun, contractRet: rec.contractRet,
      memoHex: rec.memoHex, memoText: rec.memoText, kind: rec.kind,
      confirmations: rec.confirmations, from: rec.from, to: rec.to, amountSun: rec.amountSun
    };
  }
  const tw = new TronWeb({ fullHost: (NETWORKS[network] || NETWORKS.mainnet).fullHost });
  const [info, tx] = await Promise.allSettled([
    tw.trx.getTransactionInfo(hash), tw.trx.getTransaction(hash)
  ]);
  const i = info.status === 'fulfilled' ? info.value : {};
  const t = tx.status === 'fulfilled' ? tx.value : {};
  return {
    hash, network,
    block: i.blockNumber || null,
    confirmed: !!i.blockNumber,
    feeSun: i.fee || 0,
    contractRet: t.ret && t.ret[0] ? t.ret[0].contractRet : (i.receipt ? i.receipt.result : null)
  };
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const filePath = path.normalize(path.join(ROOT, rel));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 Not Found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, {
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type' }); return res.end();
  }
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/health') {
      return json(res, 200, {
        ok: true, service: 'trust-escrow-notary', version: '1.0.0',
        defaultNetwork: TRON_NETWORK,
        tronwebInstalled: !!TronWeb,
        keyConfigured: !!process.env.TRON_PRIVATE_KEY,
        mockAvailable: !!TronWeb,
        mockWallet: TronWeb ? mock.overview().wallet.address : null
      });
    }
    if (url.pathname === '/api/mock/wallet' && req.method === 'GET') return json(res, 200, mock.overview());
    if (url.pathname === '/api/mock/balance' && req.method === 'GET') {
      const address = url.searchParams.get('address') || mock.pair('signer').address;
      const sun = mock.balance(address);
      return json(res, 200, { simulated: true, address, balanceSun: sun, balanceTrx: sun / SUN });
    }
    if (url.pathname === '/api/mock/tx' && req.method === 'GET') {
      return json(res, 200, mock.tx(url.searchParams.get('hash') || ''));
    }
    if (url.pathname === '/api/mock/transactions' && req.method === 'GET') {
      const addr = url.searchParams.get('address') || '';
      return json(res, 200, { simulated: true, height: mock.state.height, transactions: mock.transactions(addr) });
    }
    if (url.pathname === '/api/balance' && req.method === 'GET') return json(res, 200, await apiBalance(url));
    if (url.pathname === '/api/tx' && req.method === 'GET') {
      const hash = url.searchParams.get('hash') || '';
      return json(res, 200, await apiTxInfo(hash, url.searchParams.get('network') || TRON_NETWORK));
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (url.pathname === '/api/anchor') return json(res, 200, await apiAnchor(body));
      if (url.pathname === '/api/transfer') return json(res, 200, await apiTransfer(body));
      if (url.pathname === '/api/mock/faucet') {
        const addr = body.address || mock.pair('signer').address;
        // 未显式传 amountTrx 时默认 1000；显式传入则严格校验，非法值拒绝而非静默回退
        const amountSun = body.amountTrx === undefined
          ? 1000 * SUN
          : Math.round(Number(body.amountTrx) * SUN);
        return json(res, 200, mock.faucet(addr, amountSun));
      }
      if (url.pathname === '/api/mock/reset') return json(res, 200, mock.reset());
    }
    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: '未知接口' });
    return serveStatic(req, res, url.pathname);
  } catch (err) {
    const code = err.code === 'KEY_MISSING' ? 503 : err.code === 'NO_TRONWEB' ? 503 : 400;
    console.error('[api-error]', err.message);
    return json(res, code, { error: err.message, code: err.code || 'ERROR' });
  }
});

server.listen(PORT, () => {
  console.log('==========================================================');
  console.log('  信托账户完整公证提存服务已启动');
  console.log('  本地入口:    http://localhost:' + PORT + '/');
  console.log('  默认网络:    ' + TRON_NETWORK);
  console.log('  tronweb:     ' + (TronWeb ? '已安装' : '未安装（仅静态托管）'));
  console.log('  模拟链:      ' + (TronWeb ? 'SIMCHAIN 已就绪（/api/mock/*，本地演示不触达真实网络）' : '不可用'));
  console.log('  签名私钥:    ' + (process.env.TRON_PRIVATE_KEY ? '已从环境变量加载' : '未配置（真实链签名接口 503，模拟链不受影响）'));
  console.log('==========================================================');
});
