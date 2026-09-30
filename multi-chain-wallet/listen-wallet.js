#!/usr/bin/env node
/**
 * 监听钱包 Demo
 * 自动监听指定地址的到账交易，提取 data 字段并智能解码
 *
 * 支持链: tron (TRON 主网) / bsc (BSC 主网) / eth (以太坊)
 *
 * 用法:
 *   node listen-wallet.js --chain tron --address TXKRaDanNVNhXKNWTHZ24vED3wuP2J7N4t
 *   node listen-wallet.js --chain bsc  --address 0xea2d...5f8e
 *   node listen-wallet.js --chain tron --pk <私钥>          # 用私钥派生地址
 *   node listen-wallet.js --once                          # 只查一次，不循环
 */

const { program } = require('commander');
const chalk = require('chalk');
const { ethers } = require('ethers');

program
  .option('--chain <chain>', '链: tron | bsc | eth', 'tron')
  .option('--address <addr>', '监听地址（不填则用 --pk 派生）')
  .option('--pk <key>', '私钥（可选，用于派生地址）')
  .option('--interval <ms>', '轮询间隔(ms)', '8000')
  .option('--limit <n>', '每次拉取的交易数', '30')
  .option('--once', '只查询一次不循环', false)
  .option('--tronscan-key <key>', 'TronScan API Key（可选，提高限流额度）')
  .option('--demo', '演示模式：用模拟数据展示解码效果', false)
  .parse(process.argv);

const args = program.opts();

// ---------------- 已知函数选择器表 ----------------
const SELECTORS = {
  '0xa9059cbb': { name: 'transfer(address,uint256)', sig: ['function transfer(address to,uint256 amount)'] },
  '0x4e71d92d': { name: 'approve(address,uint256)',  sig: ['function approve(address spender,uint256 amount)'] },
  '0x23b872dd': { name: 'transferFrom(address,address,uint256)', sig: ['function transferFrom(address from,address to,uint256 amount)'] },
  '0x095ea7b3': { name: 'approve(address,uint256) (EIP20)', sig: ['function approve(address spender,uint256 amount)'] },
};

function decodeData(rawData) {
  if (!rawData || rawData === '0x' || rawData === '') {
    return { type: '无 data', fields: {} };
  }
  const hex = rawData.startsWith('0x') ? rawData : '0x' + rawData;
  const selector = hex.slice(0, 10).toLowerCase();

  // 1. 匹配已知函数选择器
  const known = SELECTORS[selector];
  if (known) {
    try {
      const iface = new ethers.utils.Interface(known.sig);
      const d = iface.parseTransaction({ data: hex });
      // ethers Result 同时有数字索引和命名属性，只取命名属性
      const fields = {};
      for (const [k, v] of Object.entries(d.args)) {
        if (!/^\d+$/.test(k)) fields[k] = v;
      }
      return { type: '合约调用: ' + known.name, fields };
    } catch (e) {
      // 选择器匹配但解码失败，降级
    }
  }

  // 2. 尝试当文本备注解析（支持 UTF-8 中文）
  try {
    const buf = Buffer.from(hex.slice(2), 'hex');
    if (buf.length > 0) {
      const text = buf.toString('utf8');
      // 有效 UTF-8：不含替换字符 U+FFFD
      const validUtf8 = !text.includes('\uFFFD');
      // 可打印字符（含中文）占比 > 60%
      const printable = [...text].filter(c => {
        const cp = c.codePointAt(0);
        return (cp >= 0x20 && cp <= 0x7e) || (cp >= 0x4e00 && cp <= 0x9fff) || cp === 0x0a || cp === 0x0d || cp === 0x09;
      }).length;
      if (validUtf8 && (printable / text.length > 0.6 || buf.length < 8)) {
        // 如果是 JSON 就美化
        try {
          const obj = JSON.parse(text);
          return { type: '文本备注(JSON)', fields: { json: obj } };
        } catch {
          return { type: '文本备注', fields: { text } };
        }
      }
    }
  } catch (e) {}

  // 3. 原始 hex
  return { type: '原始字节', fields: { hex: hex.slice(0, 130) + (hex.length > 130 ? '...' : '') } };
}

function fmtAmount(raw, decimals = 6) {
  try {
    const big = ethers.BigNumber.isBigNumber(raw) ? raw : ethers.BigNumber.from(raw);
    return ethers.utils.formatUnits(big, decimals);
  } catch { return String(raw); }
}

// ---------------- 代理感知的 HTTP GET ----------------
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
const TRONSCAN_KEY = args.tronscanKey || process.env.TRONSCAN_API_KEY || '';
const httpClient = axios.create({
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (listen-wallet-demo)',
    ...(TRONSCAN_KEY ? { 'TRON-PRO-API-KEY': TRONSCAN_KEY } : {}),
  },
  ...(PROXY ? { proxy: false, httpsAgent: new HttpsProxyAgent(PROXY) } : {}),
});

// ---------------- TRON 监听（基于 TronScan API） ----------------
async function watchTron(address, interval, limit, once) {
  const { TronWeb } = require('tronweb');
  const tronWeb = new TronWeb({ fullHost: 'https://api.trongrid.io' });
  const seen = new Set();

  console.log(chalk.green.bold(`\n🚀 TRON 监听钱包启动`));
  console.log(`监听地址: ${chalk.cyan(address)}`);
  console.log(`数据源:   TronScan API${PROXY ? chalk.gray(' (走代理 ' + PROXY + ')') : ''}`);
  console.log(`轮询间隔: ${interval}ms | 每次拉取: ${limit} 笔`);
  console.log(chalk.gray('等待到账交易... (Ctrl+C 退出)\n'));

  const tick = async () => {
    try {
      const url = `https://apilist.tronscanapi.com/api/transaction?sort=-timestamp&count=true&limit=${limit}&address=${address}`;
      const res = await httpClient.get(url);
      const all = (res.data && res.data.data) || [];
      // 只保留"转入"本地址的交易：toAddress 或 toAddressList 包含本地址
      const txs = all.filter(tx =>
        tx.toAddress === address || (tx.toAddressList || []).includes(address)
      );
      for (const tx of txs) {
        if (seen.has(tx.hash)) continue;
        seen.add(tx.hash);

        const contractType = tx.contractType || 0;
        const typeMap = {
          1: 'TransferContract (TRX 转账)',
          31: 'TransferAssetContract (TRC10)',
          33: 'TriggerSmartContract (合约调用)',
        };
        const typeName = typeMap[contractType] || `ContractType ${contractType}`;

        // TRX 转账金额
        const valueSun = tx.amount || 0;
        const valueTrx = valueSun ? (valueSun / 1_000_000).toFixed(6) : '0';

        // 提取 data
        const data = tx.data ? '0x' + tx.data : '';
        const decoded = decodeData(data);

        console.log(chalk.yellow('═══════════════════════════════════════════════'));
        console.log(`${chalk.green.bold('✓ 收到交易')}  ${chalk.gray(tx.hash)}`);
        console.log(`  类型:     ${chalk.magenta(typeName)}`);
        console.log(`  发送方:   ${tx.ownerAddress || '(未知)'}`);
        console.log(`  接收方:   ${tx.toAddress || '(合约调用见 data)'}`);
        console.log(`  TRX 金额: ${chalk.yellow(valueTrx + ' TRX')}`);
        console.log(`  Data 类型: ${chalk.cyan(decoded.type)}`);
        for (const [k, val] of Object.entries(decoded.fields)) {
          let display = val;
          if (k === 'amount') display = fmtAmount(val, 6) + ' (6位精度)';
          if (k === 'to') {
            try {
              const evm = val.startsWith('0x') ? val : '0x' + val;
              display = evm + chalk.gray(`  →  ${tronWeb.address.fromHex(evm)}`);
            } catch {}
          }
          console.log(`    ${chalk.blue(k)}: ${display}`);
        }
        console.log(`  时间:     ${new Date(tx.timestamp || Date.now()).toLocaleString()}`);
        console.log(`  浏览器:   https://tronscan.org/#/transaction/${tx.hash}`);
      }
    } catch (e) {
      console.error(chalk.red('轮询出错:'), (e.response ? JSON.stringify(e.response.data).slice(0,100) : e.message).slice(0, 120));
    }
  };

  await tick();
  if (!once) setInterval(tick, interval);
}

// ---------------- EVM (BSC/ETH) 监听 ----------------
async function watchEvm(chain, address, interval, limit, once) {
  const RPC = {
    bsc: 'https://bsc-dataseed.binance.org',
    eth: 'https://eth.llamarpc.com',
  };
  const provider = new ethers.providers.JsonRpcProvider(RPC[chain] || RPC.bsc);
  const seen = new Set();

  console.log(chalk.green.bold(`\n🚀 ${chain.toUpperCase()} 监听钱包启动`));
  console.log(`监听地址: ${chalk.cyan(address)}`);
  console.log(`RPC:      ${RPC[chain]}`);
  console.log(chalk.gray('等待到账交易... (Ctrl+C 退出)\n'));

  const tick = async () => {
    try {
      // EVM 没有按地址查交易的标准 RPC，这里用 etherscan 风格的第三方接口会更准
      // 这里简单演示：通过区块扫描最近 N 个区块找 to=address 的交易
      const latest = await provider.getBlockNumber();
      const fromBlock = Math.max(0, latest - 100);
      const logs = await provider.getLogs({
        fromBlock, toBlock: 'latest',
        topics: [ethers.utils.id('Transfer(address,address,uint256)')],
      });
      // 过滤出转入 address 的 ERC20 Transfer 事件
      const addrTopic = '0x' + address.toLowerCase().slice(2).padStart(64, '0');
      for (const log of logs.slice(-limit)) {
        if (log.topics[2]?.toLowerCase() !== addrTopic) continue;
        if (seen.has(log.transactionHash)) continue;
        seen.add(log.transactionHash);

        const tx = await provider.getTransaction(log.transactionHash);
        const receipt = await provider.getTransactionReceipt(log.transactionHash);
        const decoded = decodeData(tx.data);
        const from = ethers.utils.getAddress('0x' + log.topics[1].slice(26));
        const amount = ethers.utils.formatUnits(log.data, 6);

        console.log(chalk.yellow('═══════════════════════════════════════════════'));
        console.log(`${chalk.green.bold('✓ 收到 ERC20 转账')}  ${chalk.gray(log.transactionHash)}`);
        console.log(`  代币合约: ${chalk.cyan(log.address)}`);
        console.log(`  发送方:   ${from}`);
        console.log(`  金额:     ${chalk.yellow(amount + ' (6位精度)')}`);
        console.log(`  Data 类型: ${chalk.cyan(decoded.type)}`);
        for (const [k, val] of Object.entries(decoded.fields)) {
          let display = val;
          if (k === 'amount') display = fmtAmount(val, 6) + ' (6位精度)';
          console.log(`    ${chalk.blue(k)}: ${display}`);
        }
        console.log(`  区块:     ${log.blockNumber}`);
        console.log(`  浏览器:   ${chain === 'bsc' ? 'https://bscscan.com/tx/' : 'https://etherscan.io/tx/'}${log.transactionHash}`);
      }
    } catch (e) {
      console.error(chalk.red('轮询出错:'), e.message.slice(0, 100));
    }
  };

  await tick();
  if (!once) setInterval(tick, interval);
}

// ---------------- 演示模式：模拟 3 种 data 类型的到账交易 ----------------
function runDemo(myAddress) {
  const { TronWeb } = require('tronweb');
  const tronWeb = new TronWeb({ fullHost: 'https://api.trongrid.io' });
  console.log(chalk.green.bold(`\n🎬 演示模式 —— 模拟到账交易（展示 data 解码效果）`));
  console.log(`监听地址: ${chalk.cyan(myAddress)}`);
  console.log(chalk.gray('以下为模拟数据，用于演示钱包如何自动识别 data 内容\n'));

  const samples = [
    {
      title: 'TRX 转账 + 假 USDT data（transfer 编码）',
      hash: 'demo_fake_usdt_' + Math.random().toString(16).slice(2, 10),
      type: 'TransferContract (TRX 转账)',
      from: 'TKcwBWdc2PjVCydu8LrRntKKU67ENAVoY1',
      to: myAddress,
      trx: '0.000001',
      data: (() => {
        const iface = new ethers.utils.Interface(['function transfer(address to,uint256 amount)']);
        return iface.encodeFunctionData('transfer', [
          '0xea2d8c1234567890abcdef1234567890abcdef12',
          ethers.utils.parseUnits('100', 6),
        ]);
      })(),
    },
    {
      title: 'TRX 转账 + 文本备注（跨链备注）',
      hash: 'demo_text_note_' + Math.random().toString(16).slice(2, 10),
      type: 'TransferContract (TRX 转账)',
      from: 'TQ3xR1daX2AbiNGh87UHkHUh5hf6oczh6K',
      to: myAddress,
      trx: '1.500000',
      data: '0x' + Buffer.from('BSC tx: 0x8f3a...b2c1 | 跨链桥转账 50 USDT').toString('hex'),
    },
    {
      title: 'TRX 转账 + JSON 备注（自定义协议）',
      hash: 'demo_json_note_' + Math.random().toString(16).slice(2, 10),
      type: 'TransferContract (TRX 转账)',
      from: 'TNXoiAJ3dct8Fjg4M9fkLFh9S2v9TXc32G',
      to: myAddress,
      trx: '0.000002',
      data: '0x' + Buffer.from(JSON.stringify({ orderId: 'ORD-2026-0930', chain: 'BSC', amount: '88.5' })).toString('hex'),
    },
  ];

  for (const s of samples) {
    const decoded = decodeData(s.data);
    console.log(chalk.yellow('═══════════════════════════════════════════════'));
    console.log(`${chalk.green.bold('✓ ' + s.title)}`);
    console.log(`  交易哈希: ${chalk.gray(s.hash)}`);
    console.log(`  类型:     ${chalk.magenta(s.type)}`);
    console.log(`  发送方:   ${s.from}`);
    console.log(`  接收方:   ${s.to}`);
    console.log(`  TRX 金额: ${chalk.yellow(s.trx + ' TRX')}`);
    console.log(`  Data 类型: ${chalk.cyan(decoded.type)}`);
    for (const [k, val] of Object.entries(decoded.fields)) {
      let display = val;
      if (k === 'amount') display = fmtAmount(val, 6) + ' USDT (6位精度)';
      if (k === 'to') {
        try {
          const evm = val.startsWith('0x') ? val : '0x' + val;
          display = evm + chalk.gray(`  →  ${tronWeb.address.fromHex(evm)}`);
        } catch {}
      }
      if (k === 'json') display = JSON.stringify(val, null, 2).split('\n').map((l,i)=> i===0?l:'             '+l).join('\n');
      console.log(`    ${chalk.blue(k)}: ${display}`);
    }
    console.log(`  浏览器:   https://tronscan.org/#/transaction/${s.hash}`);
  }
  console.log(chalk.yellow('═══════════════════════════════════════════════'));
  console.log(chalk.green.bold('\n✅ 演示完成。') + chalk.gray(' 真实监听请去掉 --demo 参数。'));
}

// ---------------- 主流程 ----------------
(async () => {
  let address = args.address;
  if (!address && args.pk) {
    if (args.chain === 'tron') {
      const { TronWeb } = require('tronweb');
      const tw = new TronWeb({ fullHost: 'https://api.trongrid.io', privateKey: args.pk });
      address = tw.defaultAddress.base58;
    } else {
      const w = new ethers.Wallet(args.pk);
      address = w.address;
    }
  }

  // 演示模式：可省略地址
  if (args.demo) {
    runDemo(address || 'TXKRaDanNVNhXKNWTHZ24vED3wuP2J7N4t');
    return;
  }

  if (!address) {
    console.error(chalk.red('错误: 请提供 --address 或 --pk（演示模式可用 --demo）'));
    process.exit(1);
  }

  const interval = parseInt(args.interval, 10);
  const limit = parseInt(args.limit, 10);

  try {
    if (args.chain === 'tron') {
      await watchTron(address, interval, limit, args.once);
    } else {
      await watchEvm(args.chain, address, interval, limit, args.once);
    }
  } catch (e) {
    console.error(chalk.red('启动失败:'), e.message);
    process.exit(1);
  }
})();
