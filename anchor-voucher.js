#!/usr/bin/env node
/**
 * 凭证链上锚定（dry-run 优先）
 *
 * 默认只做本地预演：计算 PDF 指纹、生成 memo、打印上链参数，不发交易、不需要私钥。
 * 只有显式加 --broadcast 且设置 TRON_PRIVATE_KEY 才会真正广播。
 *
 * 用法:
 *   node anchor-voucher.js --pdf ./voucher-1408bf80.pdf --src <交易哈希> [--tx-json ./tx.json]
 *   node anchor-voucher.js ... --network nile --to Txxx --amount 1
 *   TRON_PRIVATE_KEY=... node anchor-voucher.js ... --broadcast
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TRONSCAN_API = 'https://apilist.tronscanapi.com/api/transaction-info';
const HOSTS = {
  mainnet: 'https://api.trongrid.io',
  nile: 'https://nile.trongrid.io',
};
const C = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', c: '\x1b[36m', d: '\x1b[90m', n: '\x1b[0m' };
const log = (k, v) => console.log(`${k.padEnd(16)} ${v}`);

function parseArgs(argv) {
  const a = { network: 'mainnet', amount: '1', broadcast: false, to: '' };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case '--pdf': a.pdf = v; i++; break;
      case '--src': a.src = v; i++; break;
      case '--tx-json': a.txJson = v; i++; break;
      case '--network': a.network = v; i++; break;
      case '--to': a.to = v; i++; break;
      case '--amount': a.amount = v; i++; break;
      case '--broadcast': a.broadcast = true; break;
      case '-h': case '--help': a.help = true; break;
      default: break;
    }
  }
  return a;
}

function usage() {
  console.log(`用法: node anchor-voucher.js --pdf <凭证.pdf> --src <交易哈希> [选项]

选项:
  --tx-json <file>   本地 TronScan 响应 JSON（无外网时使用）
  --network <name>   mainnet | nile（默认 mainnet）
  --to <T地址>       接收地址（默认发送方自己）
  --amount <TRX>     附带转账金额，默认 1
  --broadcast        真正广播（需 TRON_PRIVATE_KEY 环境变量）
`);
}

async function fetchTx(hash, txJson) {
  if (txJson) {
    const d = JSON.parse(fs.readFileSync(txJson, 'utf-8'));
    if (!d.hash || d.hash.toLowerCase() !== hash.toLowerCase()) throw new Error('本地 JSON 与输入哈希不一致');
    return d;
  }
  const axios = require('axios');
  const res = await axios.get(`${TRONSCAN_API}?hash=${hash}`, {
    timeout: 25000,
    headers: { 'User-Agent': 'Mozilla/5.0 (AnchorTool/1.0)' },
  });
  if (!res.data || !res.data.hash) throw new Error('TronScan 未找到该交易');
  return res.data;
}

function extractFacts(d) {
  const t = d.tokenTransferInfo || {};
  const decimals = Number(t.decimals || 6);
  const raw = t.amount_str || (d.contractData && d.contractData.amount) || '0';
  const amt = (Number(raw) / Math.pow(10, decimals)).toFixed(decimals);
  return {
    src: d.hash,
    block: d.block,
    token: t.contract_address || (d.contractData && d.contractData.contract_address) || d.toAddress || '',
    name: t.name || '',
    symbol: t.symbol || '',
    decimals,
    amt,
    from: t.from_address || d.ownerAddress || '',
    to: t.to_address || '',
    ret: d.contractRet || '',
  };
}

(async () => {
  const args = parseArgs(process.argv);
  if (args.help || !args.pdf || !args.src) { usage(); process.exit(args.help ? 0 : 1); }
  if (!/^[0-9a-fA-F]{64}$/.test(args.src)) {
    console.error(`${C.r}错误：交易哈希格式不正确（需 64 位十六进制）${C.n}`); process.exit(1);
  }
  if (!HOSTS[args.network]) {
    console.error(`${C.r}错误：--network 仅支持 mainnet / nile${C.n}`); process.exit(1);
  }
  if (!fs.existsSync(args.pdf)) {
    console.error(`${C.r}错误：找不到凭证文件 ${args.pdf}${C.n}`); process.exit(1);
  }

  // 1. 文件指纹
  const pdfBuf = fs.readFileSync(args.pdf);
  const pdfSha = crypto.createHash('sha256').update(pdfBuf).digest('hex');

  // 2. 源交易事实
  const raw = await fetchTx(args.src, args.txJson);
  const f = extractFacts(raw);

  // 3. memo（只记录可核验的链上事实 + 文件指纹）
  const memoObj = {
    ty: 'ANCHOR',
    v: 1,
    net: args.network,
    src: f.src,
    token: f.token,
    name: f.name,
    symbol: f.symbol,
    amt: f.amt,
    pdf_sha256: pdfSha,
    ts: Date.now(),
  };
  const memoJson = JSON.stringify(memoObj);
  const memoHex = Buffer.from(memoJson, 'utf-8').toString('hex');
  const memoBytes = Buffer.byteLength(memoJson, 'utf-8');

  console.log(`${C.c}==== 凭证链上锚定预演 (dry-run) ====${C.n}`);
  log('凭证文件', path.resolve(args.pdf));
  log('文件大小', `${(pdfBuf.length / 1024).toFixed(1)} KB`);
  log('PDF SHA-256', pdfSha);
  console.log('');
  log('源交易', f.src);
  log('区块高度', String(f.block));
  log('代币合约', f.token);
  log('代币名称', `${f.name}（${f.symbol}）`);
  log('转账数量', `${f.amt} ${f.symbol}`);
  log('转出地址', f.from);
  log('转入地址', f.to);
  log('交易状态', f.ret);
  console.log('');
  log('memo JSON', '');
  console.log(`${C.d}${memoJson}${C.n}`);
  log('memo 字节数', `${memoBytes} / 900`);
  log('memo HEX', '');
  console.log(`${C.d}${memoHex}${C.n}`);
  if (memoBytes > 900) {
    console.error(`${C.r}错误：memo 超过 900 字节限制，需精简字段${C.n}`); process.exit(1);
  }

  console.log('');
  log('网络', `${args.network} (${HOSTS[args.network]})`);
  log('接收地址', args.to || '(发送方自己)');
  log('附带金额', `${args.amount} TRX`);
  log('预计费用', '带宽约 300-500 字节；无免费带宽时约 0.3~1 TRX');

  if (!args.broadcast) {
    console.log('');
    console.log(`${C.y}当前为 dry-run，未广播、未使用私钥。${C.n}`);
    console.log(`${C.d}确认无误后加 --broadcast 并设置 TRON_PRIVATE_KEY 执行真实上链。${C.n}`);
    return;
  }

  // 4. 真实广播（需私钥）
  const pk = process.env.TRON_PRIVATE_KEY;
  if (!pk) {
    console.error(`${C.r}错误：--broadcast 需要环境变量 TRON_PRIVATE_KEY（请勿写在命令行/对话中）${C.n}`);
    process.exit(1);
  }

  const TronWebMod = require('tronweb');
  const TronWeb = TronWebMod.TronWeb || TronWebMod.default || TronWebMod;
  const tronWeb = new TronWeb({ fullHost: HOSTS[args.network], privateKey: pk });

  const from = tronWeb.defaultAddress.base58;
  const to = args.to || from;
  const amountSun = Math.round(Number(args.amount) * 1_000_000);
  if (!Number.isFinite(amountSun) || amountSun <= 0) {
    console.error(`${C.r}错误：--amount 无效${C.n}`); process.exit(1);
  }

  console.log('');
  console.log(`${C.c}广播中... 发送方 ${from} → ${to}，金额 ${args.amount} TRX${C.n}`);
  const tx = await tronWeb.transactionBuilder.sendTrx(to, amountSun, from, { data: memoHex });
  const signed = await tronWeb.trx.sign(tx);
  const res = await tronWeb.trx.sendRawTransaction(signed);
  if (!res.result && !res.txid) {
    console.error(`${C.r}广播失败:${C.n}`, JSON.stringify(res).slice(0, 500));
    process.exit(1);
  }
  console.log(`${C.g}✅ 已广播${C.n}`);
  log('txID', res.txid);
  log('浏览器', `https://tronscan.org/#/transaction/${res.txid}`);
})();
