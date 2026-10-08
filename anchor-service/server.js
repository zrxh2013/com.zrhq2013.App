/**
 * TRON 链上存证本地 HTTP 服务
 *
 * 接口：
 *   GET  /health              健康检查
 *   GET  /balance             查询发送方余额
 *   POST /anchor              提交存证（将任意 JSON 写入链上 memo）
 *   GET  /tx/:txid            查询交易状态与 memo 解码
 *
 * 环境变量：
 *   TRON_PRIVATE_KEY  发送方私钥（必填，从环境变量读取，不写入代码）
 *   TRON_NETWORK      网络：mainnet（默认）或 nile
 *   PORT              监听端口（默认 3000）
 */

const express = require('express');
const { TronWeb } = require('tronweb');

const app = express();
app.use(express.json({ limit: '2mb' }));

// --- 配置 ---
const PRIVATE_KEY = process.env.TRON_PRIVATE_KEY;
const NETWORK = process.env.TRON_NETWORK || 'mainnet';
const PORT = process.env.PORT || 3000;

const FULL_HOST = NETWORK === 'nile'
  ? 'https://nile.trongrid.io'
  : 'https://api.trongrid.io';

const EXPLORER = NETWORK === 'nile'
  ? 'https://nile.tronscan.org'
  : 'https://tronscan.org';

const BURN_ADDRESS = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb'; // 黑洞地址

// --- TronWeb 实例 ---
let tw;
if (PRIVATE_KEY) {
  tw = new TronWeb({ fullHost: FULL_HOST, privateKey: PRIVATE_KEY });
} else {
  // 无私钥时仍可查询，但不能签名
  tw = new TronWeb({ fullHost: FULL_HOST });
}

const SENDER = PRIVATE_KEY ? tw.defaultAddress.base58 : null;

// =========================================================
// GET /health — 健康检查
// =========================================================
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    network: NETWORK,
    sender: SENDER || 'not configured',
    privateKeyConfigured: !!PRIVATE_KEY,
  });
});

// =========================================================
// GET /balance — 查询发送方或指定地址余额
//   ?address=Txxx  可选，默认查发送方
// =========================================================
app.get('/balance', async (req, res) => {
  try {
    const addr = req.query.address || SENDER;
    if (!addr) {
      return res.status(400).json({ error: '未配置私钥且未提供 address 参数' });
    }
    const acc = await tw.trx.getAccount(addr);
    const balance = (acc.balance || 0) / 1000000;
    res.json({
      address: addr,
      balance,
      unit: 'TRX',
      network: NETWORK,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =========================================================
// POST /anchor — 提交存证
//   body: { "data": { ...任意 JSON... } }
//   限制：memo ≤ 900 字节
// =========================================================
app.post('/anchor', async (req, res) => {
  try {
    if (!PRIVATE_KEY) {
      return res.status(403).json({ error: '未配置 TRON_PRIVATE_KEY，无法签名' });
    }

    const data = req.body && req.body.data;
    if (data === undefined) {
      return res.status(400).json({ error: '缺少 data 字段' });
    }

    // 序列化为 JSON 字符串
    const memoStr = typeof data === 'string' ? data : JSON.stringify(data);
    const memoBuf = Buffer.from(memoStr, 'utf-8');
    if (memoBuf.length > 900) {
      return res.status(413).json({
        error: '存证数据超过 900 字节限制',
        size: memoBuf.length,
        max: 900,
      });
    }
    const memoHex = memoBuf.toString('hex');

    // 检查余额
    const acc = await tw.trx.getAccount(SENDER);
    const balance = (acc.balance || 0) / 1000000;
    if (balance < 1) {
      return res.status(400).json({
        error: '发送方 TRX 余额不足',
        balance,
        required: 1,
      });
    }

    // 构造 → 注入 memo → 签名 → 广播
    let tx = await tw.transactionBuilder.sendTrx(BURN_ADDRESS, 1);
    tx = await tw.transactionBuilder.addUpdateData(tx, memoHex, 'hex');
    const signed = await tw.trx.sign(tx);
    const result = await tw.trx.sendRawTransaction(signed);

    if (result.result) {
      res.json({
        success: true,
        txid: result.txid,
        network: NETWORK,
        sender: SENDER,
        memo: memoStr,
        memoHex,
        explorer: `${EXPLORER}/#/transaction/${result.txid}`,
      });
    } else {
      res.status(500).json({ error: '广播失败', detail: result });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =========================================================
// GET /tx/:txid — 查询交易状态并解码 memo
// =========================================================
app.get('/tx/:txid', async (req, res) => {
  try {
    const { txid } = req.params;
    const info = await tw.trx.getTransactionInfo(txid);
    const tx = await tw.trx.getTransaction(txid);

    let memoDecoded = null;
    if (tx && tx.raw_data && tx.raw_data.data) {
      memoDecoded = Buffer.from(
        tx.raw_data.data, 'hex'
      ).toString('utf-8');
    }

    res.json({
      txid,
      network: NETWORK,
      blockNumber: info.blockNumber || null,
      fee: (info.fee || 0) / 1000000,
      confirmed: !!info.blockNumber,
      contractRet: tx.ret ? tx.ret[0].contractRet : null,
      memo: memoDecoded,
      explorer: `${EXPLORER}/#/transaction/${txid}`,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =========================================================
// 启动
// =========================================================
app.listen(PORT, () => {
  console.log(`TRON 存证服务已启动: http://localhost:${PORT}`);
  console.log(`网络: ${NETWORK}`);
  console.log(`发送方: ${SENDER || '未配置（仅查询模式）'}`);
  console.log('');
  console.log('接口:');
  console.log(`  GET  /health        健康检查`);
  console.log(`  GET  /balance       查询余额`);
  console.log(`  POST /anchor         提交存证`);
  console.log(`  GET  /tx/:txid       查询交易`);
});
