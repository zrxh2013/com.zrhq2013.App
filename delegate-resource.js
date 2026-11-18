#!/usr/bin/env node
'use strict';

const TronWeb = require('tronweb');

const HOSTS = {
  mainnet: 'https://api.trongrid.io',
  nile: 'https://nile.trongrid.io',
};
const EXPLORERS = {
  mainnet: 'https://tronscan.org',
  nile: 'https://nile.tronscan.org',
};
const SUN = 1_000_000;

function usage() {
  console.log(`TRON Stake 2.0 资源质押与委托

用法：
  node delegate-resource.js <stake|delegate|undelegate|unfreeze> [参数]

参数：
  --network mainnet|nile   默认 nile
  --owner <地址>           资源拥有者；预演时必填
  --receiver <地址>        delegate/undelegate 的接收方
  --resource ENERGY|BANDWIDTH  默认 ENERGY
  --amount <TRX>           质押或委托的 TRX 数量，最多 6 位小数
  --lock                   委托时锁定，不能提前收回
  --lock-period <区块数>   使用 --lock 时必填；约 3 秒/块，3 天为 86400 块
  --sign                   签名但不广播，需环境变量 TRON_PRIVATE_KEY
  --broadcast              签名并广播，需环境变量 TRON_PRIVATE_KEY

示例：
  # 构造一笔 ENERGY 质押交易，不签名
  node delegate-resource.js stake --owner T资源拥有者 --resource ENERGY --amount 100

  # 将 100 TRX 对应的 ENERGY 委托给付款地址，不签名
  node delegate-resource.js delegate --owner T资源拥有者 --receiver T付款地址 --resource ENERGY --amount 100

  # 签名并广播
  export TRON_PRIVATE_KEY=资源拥有者私钥
  node delegate-resource.js delegate --receiver T付款地址 --resource ENERGY --amount 100 --broadcast

  # 收回未锁定的委托
  node delegate-resource.js undelegate --receiver T付款地址 --resource ENERGY --amount 100 --broadcast

说明：
  - delegate 使用原生 DelegateResourceContract，不是 Solidity 合约。
  - 委托前，owner 必须已通过 stake 获得足够的对应资源。
  - 委托不会把 TRX 转给 receiver，只让对方使用资源。
  - 默认只构造交易；只有 --sign 或 --broadcast 才需要私钥。
`);
}

function parseArgs(argv) {
  const command = argv[0];
  const flags = new Set(['--lock', '--sign', '--broadcast']);
  const options = {};
  for (let i = 1; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`未知参数：${key}`);
    if (flags.has(key)) {
      options[key.slice(2)] = true;
    } else {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${key} 缺少参数值`);
      options[key.slice(2)] = value;
      i += 1;
    }
  }
  return { command, options };
}

function trxToSun(value) {
  const text = String(value || '');
  if (!/^\d+(\.\d{1,6})?$/.test(text)) {
    throw new Error('--amount 必须是非负数字，最多 6 位小数');
  }
  const [whole, fraction = ''] = text.split('.');
  const sun = BigInt(whole) * BigInt(SUN) + BigInt((fraction + '000000').slice(0, 6));
  if (sun <= 0n) throw new Error('--amount 必须大于 0');
  if (sun > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('--amount 超出脚本安全范围');
  return Number(sun);
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || !['stake', 'delegate', 'undelegate', 'unfreeze'].includes(command)) {
    usage();
    return;
  }

  const network = options.network || 'nile';
  if (!HOSTS[network]) throw new Error('--network 仅支持 mainnet 或 nile');
  const resource = String(options.resource || 'ENERGY').toUpperCase();
  if (!['ENERGY', 'BANDWIDTH'].includes(resource)) {
    throw new Error('--resource 仅支持 ENERGY 或 BANDWIDTH');
  }
  const amountSun = trxToSun(options.amount);
  const privateKey = (process.env.TRON_PRIVATE_KEY || '').trim().replace(/^0x/, '');
  if ((options.sign || options.broadcast) && !/^[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error('签名或广播前，请设置 64 位十六进制环境变量 TRON_PRIVATE_KEY');
  }

  const tronWeb = new TronWeb({
    fullHost: HOSTS[network],
    ...(privateKey ? { privateKey } : {}),
  });
  const signingAddress = privateKey ? tronWeb.defaultAddress.base58 : '';
  const owner = options.owner || signingAddress;
  if (!owner || !tronWeb.isAddress(owner)) {
    throw new Error('预演时必须通过 --owner 提供合法资源拥有者地址');
  }
  if (options.owner && signingAddress && options.owner !== signingAddress) {
    throw new Error(`--owner 与私钥地址不一致：私钥地址为 ${signingAddress}`);
  }
  tronWeb.setAddress(owner);

  const receiver = options.receiver;
  if (['delegate', 'undelegate'].includes(command)) {
    if (!receiver || !tronWeb.isAddress(receiver)) {
      throw new Error(`${command} 必须通过 --receiver 提供合法接收地址`);
    }
    if (receiver === owner) throw new Error('receiver 不能与 owner 相同');
  }

  let lockPeriod;
  if (options.lock) {
    if (command !== 'delegate') throw new Error('--lock 仅用于 delegate');
    lockPeriod = Number(options['lock-period']);
    if (!Number.isInteger(lockPeriod) || lockPeriod <= 0) {
      throw new Error('使用 --lock 时必须提供正整数 --lock-period（区块数）');
    }
  } else if (options['lock-period']) {
    throw new Error('--lock-period 必须与 --lock 一起使用');
  }

  let tx;
  if (command === 'stake') {
    tx = await tronWeb.transactionBuilder.freezeBalanceV2(amountSun, resource, owner);
  } else if (command === 'unfreeze') {
    tx = await tronWeb.transactionBuilder.unfreezeBalanceV2(amountSun, resource, owner);
  } else if (command === 'delegate') {
    tx = await tronWeb.transactionBuilder.delegateResource(
      amountSun,
      receiver,
      resource,
      owner,
      Boolean(options.lock),
      lockPeriod
    );
  } else {
    tx = await tronWeb.transactionBuilder.undelegateResource(amountSun, receiver, resource, owner);
  }

  const contract = tx.raw_data.contract[0];
  console.log(JSON.stringify({
    mode: options.broadcast ? 'BROADCAST' : options.sign ? 'SIGNED_ONLY' : 'DRY_RUN',
    command,
    network,
    owner,
    receiver: receiver || null,
    resource,
    amountTrx: amountSun / SUN,
    lock: Boolean(options.lock),
    lockPeriod: lockPeriod || null,
    contractType: contract.type,
    txID: tx.txID,
    rawContract: contract,
  }, null, 2));

  if (!options.sign && !options.broadcast) {
    console.log('\n仅构造交易，未签名、未广播。');
    return;
  }

  const signed = await tronWeb.trx.sign(tx);
  console.log(`\n已签名，签名数量：${signed.signature.length}`);
  if (!options.broadcast) {
    console.log('未广播。');
    return;
  }

  const receipt = await tronWeb.trx.broadcast(signed);
  console.log('\n广播结果：' + JSON.stringify(receipt, null, 2));
  if (!receipt.result) process.exitCode = 1;
  if (receipt.txid) {
    console.log(`浏览器：${EXPLORERS[network]}/#/transaction/${receipt.txid}`);
  }
}

main().catch((error) => {
  console.error('执行失败：' + (error && error.message ? error.message : error));
  process.exitCode = 1;
});
