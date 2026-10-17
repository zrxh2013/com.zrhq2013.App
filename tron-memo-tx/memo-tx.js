#!/usr/bin/env node
/**
 * TRON 带 memo 测试交易脚本（构造 → 离线签名 → 广播 → 确认，四步分离）
 *
 * 依赖: npm install tronweb
 * 私钥: 仅从环境变量 FROM_PRIVATE_KEY 读取，禁止写入命令行参数或文件
 *
 * 用法:
 *   # 0) 查余额
 *   node memo-tx.js balance --net nile --address Txxxx
 *
 *   # 1) 联网机构造未签名交易（可只传 --from 地址，无需私钥）
 *   node memo-tx.js build --net nile \
 *       --to T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb --amount-sun 1 \
 *       --memo '{"ty":"ANCHOR","v":1,"data":"hello-tron"}' \
 *       --out unsigned.tx.json
 *
 *   # 2) 离线机签名（断网执行；FROM_PRIVATE_KEY 永不触网）
 *   FROM_PRIVATE_KEY=0xyourkey node memo-tx.js sign \
 *       --in unsigned.tx.json --out signed.tx.json
 *       # 注意：TRON 交易引用区块(TAPOS)，构造后约 60 秒内必须广播，超时需重新 build
 *
 *   # 3) 联网机广播（只需 signed.tx.json，不需要私钥）
 *   node memo-tx.js broadcast --net nile --in signed.tx.json
 *
 *   # 4) 轮询等待上链确认
 *   node memo-tx.js wait --net nile --id <txID>
 *
 *   # 5) 按金额查询某地址的 TRX 流水（扫描历史，本地过滤；TRX 原生转账）
 *   node memo-tx.js query --net nile --address Txxxx --amount 12.34
 *   node memo-tx.js query --address Txxxx --min-trx 1 --max-trx 100 --direction out
 *   node memo-tx.js query --address Txxxx --amount-sun 154 --memo-substr ANCHOR --json
 *   node memo-tx.js query --address Txxxx --start 2026-10-01 --end 2026-10-17   # 时间窗口(UTC, --end 含当天)
 *
 *   # 一步到位（在线热钱包模式，Nile 测试网）
 *   FROM_PRIVATE_KEY=0xyourkey node memo-tx.js run --net nile
 *
 * 网络: --net nile(默认, 测试网) | main(主网；广播/run 需额外设置 TRON_MAINNET_CONFIRM=YES)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { TronWeb } = require('tronweb');

const NETWORKS = {
  nile: { host: 'https://nile.trongrid.io',  explorer: 'https://nile.tronscan.org/#/transaction/' },
  main: { host: 'https://api.trongrid.io',  explorer: 'https://tronscan.org/#/transaction/' },
};
const BURN_ADDRESS = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb'; // 黑洞地址，1 drop(1 sun) 存证常用
const MEMO_MAX_BYTES = 900;                                   // 单条 memo 安全上限
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 参数解析 ---------------- */
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { args[key] = true; }
      else { args[key] = next; i++; }
    } else args._.push(a);
  }
  return args;
}

function tron(net, privateKey) {
  const cfg = { fullHost: NETWORKS[net].host, headers: { 'TRON-PRO-API-KEY': process.env.TRONGRID_API_KEY || '' } };
  if (privateKey) cfg.privateKey = privateKey;
  return new TronWeb(cfg);
}

function requireKey() {
  const key = process.env.FROM_PRIVATE_KEY;
  if (!key) throw new Error('缺少私钥：请设置环境变量 FROM_PRIVATE_KEY（不要用命令行参数传递）');
  return key.startsWith('0x') ? key : '0x' + key;
}

function guardMainnet(net, action) {
  if (net === 'main' && process.env.TRON_MAINNET_CONFIRM !== 'YES') {
    throw new Error(`拒绝在主网执行「${action}」：主网操作会真实花费 TRX，确认无误后请追加环境变量 TRON_MAINNET_CONFIRM=YES`);
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function buildMemo(memoArg) {
  const memo = memoArg === true || memoArg === undefined
    ? JSON.stringify({
        ty: 'ANCHOR', v: 1,
        ts: new Date().toISOString(),
        nonce: crypto.randomBytes(6).toString('hex'),
        data: 'tron-memo-test',
      })
    : String(memoArg);
  const bytes = Buffer.byteLength(memo, 'utf8');
  if (bytes > MEMO_MAX_BYTES) {
    throw new Error(`memo 为 ${bytes} 字节，超过安全上限 ${MEMO_MAX_BYTES} 字节，请拆分多条交易`);
  }
  return { memo, hex: Buffer.from(memo, 'utf8').toString('hex'), bytes };
}

/* ---------------- 子命令 ---------------- */

// balance --net nile --address Txxxx
async function cmdBalance(net, a) {
  if (!a.address) throw new Error('需要 --address Txxxx');
  const tw = tron(net);
  const acc = await tw.trx.getAccount(a.address); // 未激活地址返回空对象
  console.log('地址      :', a.address);
  console.log('余额      :', ((acc.balance || 0) / 1e6).toFixed(6), 'TRX');
}

// build --net nile --from Txxx --to Txxx --amount-sun 1 --memo '...' --out unsigned.tx.json
async function cmdBuild(net, a) {
  const key = process.env.FROM_PRIVATE_KEY
    ? (process.env.FROM_PRIVATE_KEY.startsWith('0x') ? process.env.FROM_PRIVATE_KEY : '0x' + process.env.FROM_PRIVATE_KEY)
    : null;
  const from = a.from || (key ? TronWeb.address.fromPrivateKey(key) : null);
  if (!from) throw new Error('需要发送方：传 --from T地址，或设置 FROM_PRIVATE_KEY 自动推导');
  const to = a.to || BURN_ADDRESS;

  let amountSun;
  if (a['amount-trx'] !== undefined) amountSun = Math.round(Number(a['amount-trx']) * 1e6);
  else amountSun = a['amount-sun'] !== undefined ? Number(a['amount-sun']) : 1;
  if (!Number.isInteger(amountSun) || amountSun <= 0) throw new Error('金额非法：--amount-sun 必须为正整数（1 TRX = 1,000,000 sun）');

  const { memo, hex: memoHex, bytes } = buildMemo(a.memo);

  const tw = tron(net, key || undefined);
  console.log('构造交易  :', net, from, '->', to, amountSun, 'sun');
  console.log('memo      :', memo, `(${bytes} 字节)`);

  // 关键：data 选项由 SDK 写入 protobuf，切勿手拼 raw_data，否则 txID 与签名不匹配报 SIGERROR
  const unsignedTx = await tw.transactionBuilder.sendTrx(to, amountSun, from, { data: memoHex });

  const out = a.out || 'unsigned.tx.json';
  writeJson(out, unsignedTx);
  const ttlMs = Number(unsignedTx.raw_data.expiration) - Date.now();
  console.log('txID      :', unsignedTx.txID, '（签名前已确定）');
  console.log('过期时间  :', new Date(Number(unsignedTx.raw_data.expiration)).toISOString(),
    `（约 ${Math.round(ttlMs / 1000)} 秒后失效，TAPOS 引用块过期需重新 build）`);
  console.log('已写出    :', path.resolve(out));
  console.log('下一步    : FROM_PRIVATE_KEY=... node memo-tx.js sign --in', out, '--out signed.tx.json');
}

// sign --in unsigned.tx.json --out signed.tx.json   （可完全离线执行）
async function cmdSign(_net, a) {
  const key = requireKey();
  const file = a.in || 'unsigned.tx.json';
  const unsignedTx = readJson(file);
  if (!unsignedTx.raw_data || !unsignedTx.txID) throw new Error('输入文件不像合法的未签名交易（缺少 raw_data/txID）');
  if (Array.isArray(unsignedTx.signature) && unsignedTx.signature.length) {
    throw new Error('该交易已包含签名，拒绝重复签名');
  }

  // 签名是纯本地 secp256k1 运算，fullHost 不会被调用，断网也能执行
  // fullHost 必须是合法 URL 才能通过构造校验；trx.sign 是纯本地运算，不会访问它
  const tw = new TronWeb({ fullHost: 'http://127.0.0.1:1', privateKey: key });
  const signer = TronWeb.address.fromPrivateKey(key);

  // 校验签名者 == owner，提前拦截最常见的 SIGERROR
  const ownerHex = unsignedTx.raw_data.contract[0].parameter.value.owner_address;
  const ownerB58 = TronWeb.address.fromHex(ownerHex);
  if (signer !== ownerB58) {
    throw new Error(`私钥地址 ${signer} 与交易 owner ${ownerB58} 不一致，签名必然被节点拒绝`);
  }

  const ttlMs = Number(unsignedTx.raw_data.expiration) - Date.now();
  if (ttlMs <= 0) throw new Error('交易已过 TAPOS 有效期，请重新执行 build 后立即签名');
  console.log('签名者    :', signer, `(有效期剩余约 ${Math.round(ttlMs / 1000)} 秒)`);

  const signedTx = await tw.trx.sign(unsignedTx);
  const out = a.out || 'signed.tx.json';
  writeJson(out, signedTx);
  console.log('签名串    :', signedTx.signature[0].slice(0, 32) + '…', `(${signedTx.signature[0].length / 2} 字节)`);
  console.log('已写出    :', path.resolve(out));
  console.log('下一步    : 把该文件拷到联网机，执行 node memo-tx.js broadcast --in', out);
}

// broadcast --net nile --in signed.tx.json
async function cmdBroadcast(net, a) {
  guardMainnet(net, 'broadcast');
  const file = a.in || 'signed.tx.json';
  const signedTx = readJson(file);
  if (!signedTx.txID || !Array.isArray(signedTx.signature) || !signedTx.signature.length) {
    throw new Error('输入文件缺少 txID/signature，无法广播');
  }
  const ttlMs = Number(signedTx.raw_data.expiration) - Date.now();
  if (ttlMs <= 0) throw new Error('交易已过期，签名作废：请重新 build → sign → 尽快 broadcast');

  const tw = tron(net);
  console.log('广播中    :', signedTx.txID);

  // 节点失败时往往返回 HTTP 200 + {result:false}，且网络抖动可安全重放（txID 不变）
  let result;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      result = await tw.trx.sendRawTransaction(signedTx);
      break;
    } catch (e) {
      if (attempt === 2) throw e;
      console.log('网络异常，2 秒后用同一笔签名交易重试（不会重复扣款）…', e.message);
      await sleep(2000);
    }
  }

  // 协议层门禁：必须显式判断 result === true
  if (!result || result.result !== true) {
    let msg = result && result.message;
    if (msg && /^[0-9a-f]+$/i.test(msg)) {
      try { msg = Buffer.from(msg, 'hex').toString('utf8'); } catch {}
    }
    throw new Error('广播被节点拒绝: ' + JSON.stringify({ code: result && result.code, message: msg }));
  }

  console.log('广播成功  :', NETWORKS[net].explorer + signedTx.txID);
  if (!a['no-wait']) {
    await cmdWait(net, { id: signedTx.txID, timeout: a.timeout || 60000 });
  }
}

// wait --net nile --id <txID>
async function cmdWait(net, a) {
  if (!a.id) throw new Error('需要 --id <txID>');
  const timeout = Number(a.timeout || 60000);
  const tw = tron(net);
  const t0 = Date.now();
  console.log('等待确认  : 轮询间隔 3 秒，超时', timeout / 1000, '秒');
  while (Date.now() - t0 < timeout) {
    await sleep(3000);
    const info = await tw.trx.getTransactionInfo(a.id).catch(() => null);
    if (info && info.blockNumber && info.blockNumber > 0) {
      console.log('已上链    : 区块 #' + info.blockNumber);
      console.log('手续费    :', (Number(info.fee || 0) / 1e6), 'TRX');
      console.log('合约结果  :', (info.receipt && info.receipt.result) || '(普通转账无 receipt)');
      console.log('浏览器    :', NETWORKS[net].explorer + a.id);
      return info;
    }
    process.stdout.write('.');
  }
  throw new Error('超时未确认。请稍后用同一 txID 执行 wait 重查，切勿重新构造交易（避免重复转账）');
}

// query --net nile --address Txxx [--amount 12.34 | --amount-sun N | --min-trx/--max-trx]
//       [--direction in|out|all] [--memo-substr s] [--start 2026-10-01 --end 2026-10-17]
//       [--limit 20] [--max-pages 20] [--json] [--full]
function parseTimeArg(v, name) {
  if (v === undefined || v === true || v === null) return null;
  const s = String(v).trim();
  // 纯数字按毫秒时间戳；否则按 ISO8601 / YYYY-MM-DD 解析
  const ms = /^\d+$/.test(s) ? Number(s) : Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T00:00:00Z' : s);
  if (!Number.isFinite(ms)) throw new Error(`时间参数 --${name} 无法解析: ${s}（示例：2026-10-01 或 2026-10-01T08:30:00Z 或毫秒时间戳）`);
  return ms;
}

async function cmdQuery(net, a) {
  if (!a.address) throw new Error('需要 --address Txxxx');
  const base58 = TronWeb.isAddress(a.address)
    ? (a.address.startsWith('T') ? a.address : TronWeb.address.fromHex(a.address))
    : null;
  if (!base58) throw new Error('地址格式非法: ' + a.address);

  // 金额条件（sun）：--amount(TRX 精确) | --amount-sun(精确) | --min-trx/--max-trx(范围)
  let exactSun = null, minSun = null, maxSun = null;
  if (a['amount-trx'] !== undefined) exactSun = Math.round(Number(a['amount-trx']) * 1e6);
  else if (a['amount'] !== undefined && a['amount'] !== true) exactSun = Math.round(Number(a['amount']) * 1e6);
  else if (a['amount-sun'] !== undefined) exactSun = Number(a['amount-sun']);
  if (a['min-trx'] !== undefined) minSun = Math.round(Number(a['min-trx']) * 1e6);
  if (a['max-trx'] !== undefined) maxSun = Math.round(Number(a['max-trx']) * 1e6);
  if (a['min-sun'] !== undefined) minSun = Number(a['min-sun']);
  if (a['max-sun'] !== undefined) maxSun = Number(a['max-sun']);
  if (exactSun !== null && (!Number.isInteger(exactSun) || exactSun <= 0)) throw new Error('金额非法');
  if (minSun !== null && maxSun !== null && minSun > maxSun) throw new Error('金额范围非法：min > max');

  const direction = ['in', 'out', 'all'].includes(a.direction) ? a.direction : 'all';
  const memoSub = a['memo-substr'] && a['memo-substr'] !== true ? String(a['memo-substr']) : null;
  const want = Math.max(1, parseInt(a.limit || '20', 10));
  const maxPages = Math.max(1, parseInt(a['max-pages'] || '20', 10));
  const includeFailed = a['include-failed'] === true || a['include-failed'] === 'true';
  const pageSize = 200;

  // 时间窗口（毫秒，UTC）：同时下推给节点并在本地兜底过滤
  const startMs = parseTimeArg(a.start, 'start');
  let endMs = parseTimeArg(a.end, 'end');
  if (endMs !== null && /^\d{4}-\d{2}-\d{2}$/.test(String(a.end).trim())) endMs += 24 * 3600 * 1000 - 1; // --end 日期含当天
  if (startMs !== null && endMs !== null && startMs > endMs) throw new Error('时间范围非法：--start 晚于 --end');

  const headers = { accept: 'application/json' };
  if (process.env.TRONGRID_API_KEY) headers['TRON-PRO-API-KEY'] = process.env.TRONGRID_API_KEY;

  const decodeMemo = (hex) => {
    if (!hex) return '';
    const buf = Buffer.from(hex, 'hex');
    const s = buf.toString('utf8');
    // 只保留常见可打印文本，二进制 memo 标记为 [binary N bytes]
    return /^[\x09\x0a\x0d\x20-\x7e一-鿿　-〿＀-￯]*$/.test(s) && s.replace(/\s/g, '').length
      ? s : `[binary ${buf.length} bytes]`;
  };

  const rows = [];
  let fingerprint = null, scanned = 0, pages = 0;
  while (pages < maxPages && rows.length < want) {
    const q = new URLSearchParams({ limit: String(pageSize), only_confirmed: 'true', order_by: 'block_timestamp,desc' });
    if (fingerprint) q.set('fingerprint', fingerprint);
    if (startMs !== null) q.set('min_timestamp', String(startMs));
    if (endMs !== null) q.set('max_timestamp', String(endMs));
    const url = `${NETWORKS[net].host}/v1/accounts/${encodeURIComponent(base58)}/transactions?${q}`;

    // 公共节点无 API key 时限流(429)/偶发 5xx：指数退避重试
    let resp = null, j = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      resp = await fetch(url, { headers });
      if (resp.ok || (resp.status !== 429 && resp.status < 500)) break;
      if (attempt === 3) throw new Error(`TronGrid HTTP ${resp.status}：请求过于频繁，请稍后再试或设置 TRONGRID_API_KEY`);
      await sleep(1500 * attempt);
    }
    if (!resp.ok) throw new Error(`TronGrid HTTP ${resp.status} ${resp.statusText}`);
    j = await resp.json();
    if (!j || j.success === false) throw new Error('TronGrid 返回错误: ' + JSON.stringify(j.error || j));
    const data = Array.isArray(j.data) ? j.data : [];
    pages++;
    if (!data.length) break;

    let reachedStart = false;
    for (const tx of data) {
      scanned++;
      const ts = Number(tx.block_timestamp) || 0;
      // 结果按时间倒序：一旦早于窗口起点，后面的都更早，直接终止全部翻页
      if (startMs !== null && ts && ts < startMs) { reachedStart = true; break; }
      if (endMs !== null && ts && ts > endMs) continue;
      const contract = (tx.raw_data && tx.raw_data.contract || []).find((c) => c.type === 'TransferContract');
      if (!contract) continue; // 只统计 TRX 原生转账；TRC20(USDT) 走另一个接口
      const v = contract.parameter.value;
      const success = (tx.ret && tx.ret[0] && tx.ret[0].contractRet === 'SUCCESS');
      if (!includeFailed && !success) continue;
      const owner = v.owner_address.startsWith('T') ? v.owner_address : TronWeb.address.fromHex(v.owner_address);
      const to = v.to_address.startsWith('T') ? v.to_address : TronWeb.address.fromHex(v.to_address);
      const amount = Number(v.amount);
      const dir = owner === base58 ? 'out' : 'in';
      if (direction !== 'all' && dir !== direction) continue;
      if (exactSun !== null && amount !== exactSun) continue;
      if (minSun !== null && amount < minSun) continue;
      if (maxSun !== null && amount > maxSun) continue;
      const memo = decodeMemo(tx.raw_data.data);
      if (memoSub && !memo.includes(memoSub)) continue;

      rows.push({
        time: new Date(Number(tx.block_timestamp)).toISOString().replace('.000Z', 'Z'),
        dir, counterparty: dir === 'out' ? to : owner,
        amountSun: amount, amountTrx: amount / 1e6,
        memo, success, txID: tx.txID,
        explorer: NETWORKS[net].explorer + tx.txID,
      });
      if (rows.length >= want) break;
    }
    if (reachedStart) break;
    fingerprint = j.meta && j.meta.fingerprint;
    if (!fingerprint) break;
  }

  if (a.json) {
    console.log(JSON.stringify({ address: base58, net, scanned, pages, matches: rows }, null, 2));
    return;
  }
  console.log('地址      :', base58, '| 网络:', net);
  const cond = [];
  if (exactSun !== null) cond.push('金额=' + exactSun / 1e6 + ' TRX');
  if (minSun !== null || maxSun !== null) cond.push('范围=' + ((minSun ?? 0) / 1e6) + '~' + ((maxSun ?? Infinity) / 1e6) + ' TRX');
  if (direction !== 'all') cond.push('方向=' + direction);
  if (memoSub) cond.push('memo含"' + memoSub + '"');
  if (startMs !== null || endMs !== null) {
    cond.push('时间=' +
      (startMs ? new Date(startMs).toISOString().replace('.000Z', 'Z') : '最早') + ' ~ ' +
      (endMs ? new Date(endMs).toISOString().replace('.000Z', 'Z') : '最新'));
  }
  console.log('条件      :', cond.join('，') || '全部 TRX 转账');
  console.log(`扫描 ${scanned} 笔交易 / ${pages} 页，命中 ${rows.length} 笔${rows.length === want ? '（达到 --limit，可继续翻页）' : ''}`);
  if (!rows.length) return;
  for (const r of rows) {
    const short = a.full ? r.txID : r.txID.slice(0, 16) + '…';
    console.log('──────────────────────────────────────');
    console.log(`${r.time}  ${r.dir === 'out' ? '支出 →' : '收入 ←'}  ${r.amountTrx} TRX${r.success ? '' : ' [失败]'}`);
    console.log('对方      :', r.counterparty);
    console.log('txID      :', short, r.explorer);
    if (r.memo) console.log('memo      :', r.memo.length > 80 ? r.memo.slice(0, 80) + '…' : r.memo);
  }
}

// run --net nile  （在线模式：build+sign+broadcast+wait 一次完成）
async function cmdRun(net, a) {
  guardMainnet(net, 'run');
  const key = requireKey();
  const from = TronWeb.address.fromPrivateKey(key);
  const to = a.to || BURN_ADDRESS;
  let amountSun;
  if (a['amount-trx'] !== undefined) amountSun = Math.round(Number(a['amount-trx']) * 1e6);
  else amountSun = a['amount-sun'] !== undefined ? Number(a['amount-sun']) : 1;
  const { memo, hex: memoHex } = buildMemo(a.memo);

  const tw = tron(net, key);
  console.log('在线模式  :', net, from, '->', to, amountSun, 'sun');
  console.log('memo      :', memo);

  const unsignedTx = await tw.transactionBuilder.sendTrx(to, amountSun, from, { data: memoHex });
  console.log('txID      :', unsignedTx.txID);
  const signedTx = await tw.trx.sign(unsignedTx);
  const result = await tw.trx.sendRawTransaction(signedTx);
  if (!result || result.result !== true) {
    throw new Error('广播被节点拒绝: ' + JSON.stringify(result));
  }
  console.log('广播成功  :', NETWORKS[net].explorer + signedTx.txID);
  await cmdWait(net, { id: signedTx.txID, timeout: a.timeout || 60000 });
}

/* ---------------- main ---------------- */
(async () => {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const net = NETWORKS[args.net] ? args.net : 'nile';
  try {
    switch (cmd) {
      case 'balance':   await cmdBalance(net, args); break;
      case 'build':     await cmdBuild(net, args); break;
      case 'sign':      await cmdSign(net, args); break;
      case 'broadcast': await cmdBroadcast(net, args); break;
      case 'wait':      await cmdWait(net, args); break;
      case 'query':
      case 'find':      await cmdQuery(net, args); break;
      case 'run':       await cmdRun(net, args); break;
      default:
        console.log('用法: node memo-tx.js <balance|build|sign|broadcast|wait|query|run> [选项]\n' +
                    '默认网络 nile 测试网；主网需 TRON_MAINNET_CONFIRM=YES。详见文件头注释。');
        process.exit(cmd ? 1 : 0);
    }
  } catch (e) {
    console.error('错误:', e.message || e);
    process.exit(1);
  }
})();
