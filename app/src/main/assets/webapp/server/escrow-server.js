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

async function apiBalance(url) {
  const address = url.searchParams.get('address') || '';
  const network = url.searchParams.get('network') || TRON_NETWORK;
  if (!isValidT(address)) throw new Error('地址格式不正确');
  const tw = new TronWeb({ fullHost: (NETWORKS[network] || NETWORKS.mainnet).fullHost });
  const acc = await tw.trx.getAccount(address);
  return { address, network, balanceSun: acc.balance || 0, balanceTrx: (acc.balance || 0) / SUN };
}

async function apiAnchor(body) {
  const network = body.network || TRON_NETWORK;
  if (!isHex(body.memoHex)) throw new Error('memoHex 非法（须为偶数长度十六进制，≤900 字节）');
  const tw = getTron(network);
  const tx = await tw.transactionBuilder.sendTrx(BURN_ADDRESS, 1, undefined, { data: body.memoHex.toLowerCase() });
  const signed = await tw.trx.sign(tx);
  const r = await tw.trx.sendRawTransaction(signed);
  if (!r.result) throw new Error('锚定交易广播被节点拒绝: ' + JSON.stringify(r));
  return { txid: r.txid, burn: BURN_ADDRESS, network, explorer: (network === 'nile' ? 'https://nile.tronscan.org/#/transaction/' : 'https://tronscan.io/#/transaction/') + r.txid };
}

async function apiTransfer(body) {
  const network = body.network || TRON_NETWORK;
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

  const opts = body.memoHex ? { data: body.memoHex.toLowerCase() } : undefined;
  const tx = await tw.transactionBuilder.sendTrx(to, amountSun, undefined, opts);
  const signed = await tw.trx.sign(tx);
  const r = await tw.trx.sendRawTransaction(signed);
  if (!r.result) throw new Error('提存交易广播被节点拒绝: ' + JSON.stringify(r));
  return { txid, token: 'TRX', to, amountSun, network, explorer: (network === 'nile' ? 'https://nile.tronscan.org/#/transaction/' : 'https://tronscan.io/#/transaction/') + r.txid };
}

async function apiTxInfo(hash, network) {
  if (!/^[0-9a-fA-F]{64}$/.test(hash)) throw new Error('交易哈希须为 64 位十六进制');
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
        keyConfigured: !!process.env.TRON_PRIVATE_KEY
      });
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
  console.log('  签名私钥:    ' + (process.env.TRON_PRIVATE_KEY ? '已从环境变量加载' : '未配置（签名接口 503，只读可用）'));
  console.log('==========================================================');
});
