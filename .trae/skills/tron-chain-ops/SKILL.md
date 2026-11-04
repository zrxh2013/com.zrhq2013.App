---
name: "tron-chain-ops"
description: "TRON 链上操作：TRX 转账、带 memo 上链存证、余额查询、交易确认，以及按金额/方向/memo/时间窗口查询地址流水（金额指纹认款）。当用户需要在 TRON 主网/Nile 测试网发交易、离线签名广播分离、或按金额查 TRX 转账时调用。"
---

# TRON 链上操作（tron-chain-ops）

封装 TRON 网络常见操作：余额查询、TRX 转账、带 memo 的上链存证、构造/离线签名/广播/确认分离、以及**按金额查询地址流水（交易所式金额指纹认款）**。

- 主网：`https://api.trongrid.io`　Nile 测试网：`https://nile.trongrid.io`
- 浏览器：主网 `https://tronscan.org/#/transaction/<txID>`，Nile `https://nile.tronscan.org/#/transaction/<txID>`
- 工作区内已有可运行参考脚本：`/workspace/tron-memo-tx/memo-tx.js`（tronweb 6.x，含全部子命令）

## 前置条件与安全红线

- Node.js + `tronweb`（v6 已验证；`npm install tronweb`）。
- **私钥只从环境变量 `FROM_PRIVATE_KEY` 读取**，禁止写入命令行参数、代码或文件；日志中绝不打印私钥。
- 主网写操作必须二次确认（如环境变量 `TRON_MAINNET_CONFIRM=YES`）；默认走 Nile。
- 广播前确认余额 ≥ 转账额 + 带宽/能量费；测试网 TRX 与主网互不通用。
- 存证常用黑洞地址 `T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb`，打 1 sun。

## 核心事实（先理解再动手）

1. 交易生命周期：`createtransaction → sign（纯离线 secp256k1）→ broadcasttransaction → 轮询确认`。
2. **txID 在构造完成时即确定**（raw_data protobuf 的 SHA256），签名只追加 `signature` 字段。同一笔签名交易可安全重放/重试，节点去重；但重新构造会生成新 txID，可能造成重复转账。
3. **TAPOS**：raw_data 引用构造时的区块，有效期约 60 秒。签名后要立即广播，超时必须重新 build → sign。
4. 广播接口失败常返回 **HTTP 200 + `{result:false, code, message}`**，必须显式判断 `result === true`；`message` 常是 hex 编码的错误文本，需 hex→utf8 解码。
5. 广播成功 ≠ 到账：拿到 `blockNumber` 才算上链；TRC20 还要看 `receipt.result`（合约 revert 时交易上链但转账失败，费用照扣）。

## 1. 余额查询

```js
const { TronWeb } = require('tronweb');
const tw = new TronWeb({ fullHost: 'https://api.trongrid.io' });
const acc = await tw.trx.getAccount('<T地址>'); // 未激活地址返回空对象，按余额 0 处理
console.log((acc.balance || 0) / 1e6, 'TRX');
```

## 2. TRX 转账 / 带 memo 存证（推荐三步分离，勿用 sendTransaction 一把梭）

```js
const tw = new TronWeb({ fullHost: 'https://api.trongrid.io', privateKey: process.env.FROM_PRIVATE_KEY });

const memoHex = Buffer.from(JSON.stringify({ ty: 'ANCHOR', v: 1, data: '...' }), 'utf8').toString('hex');

// ① 构造（联网）：memo 必须用 data 选项，切勿手拼 protobuf
const unsignedTx = await tw.transactionBuilder.sendTrx(toAddress, 1_000_000, fromAddress, { data: memoHex });
//                                                          金额单位 sun，1 TRX = 1e6
// ② 签名（纯本地，可断网）
const signedTx = await tw.trx.sign(unsignedTx);
// ③ 广播（联网）
const result = await tw.trx.sendRawTransaction(signedTx);
if (!result || result.result !== true) throw new Error('广播被拒: ' + JSON.stringify(result));
```

- memo 安全上限约 900 字节，超限拆多笔（每批 ≤ 3 条）。
- 离线机上构造 TronWeb 时 fullHost 仍须是**合法 URL**（tronweb v6 构造期校验，`:0` 端口会报 Invalid URL），用 `http://127.0.0.1:1` 即可，`trx.sign` 不会访问网络。
- 签名前校验私钥地址 == `raw_data.contract[0].parameter.value.owner_address`（hex 用 `TronWeb.address.fromHex` 转换），可提前拦截 SIGERROR。

## 3. 交易确认（轮询）

```js
async function waitConfirmed(tw, txid, timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await new Promise(r => setTimeout(r, 3000)); // TRON 3 秒出块
    const info = await tw.trx.getTransactionInfo(txid).catch(() => null);
    if (info && info.blockNumber > 0) return info; // 含 fee、receipt.result
  }
  throw new Error('超时：只能用原 txID 重查，禁止重新构造重发');
}
```

## 4. 按金额查询地址流水 / 金额指纹认款（重点复用流程）

**链上不存在"按金额全网搜索"的 RPC**。正确模式：指定收款地址 → 拉该地址 TRX 转账流水（TronGrid v1，fingerprint 游标分页）→ 本地按金额/方向/memo/时间过滤。交易所认款 = 给每个用户分配唯一零头金额（如 12.583 TRX），入账匹配 金额 + 时间窗口。

接口：`GET {host}/v1/accounts/{base58地址}/transactions?limit=200&only_confirmed=true&order_by=block_timestamp,desc&fingerprint=<游标>`
- 时间过滤参数：`min_timestamp` / `max_timestamp`（**毫秒**），下推给节点减数据量，本地再兜底。
- 响应：`{ success, data: [...], meta: { fingerprint } }`；`data[].raw_data.contract[]` 中取 `type === 'TransferContract'`；金额在 `parameter.value.amount`（sun），地址字段可能是 base58 也可能是 hex（用是否以 `T` 开头判断，hex 走 `TronWeb.address.fromHex`）；memo 在 `raw_data.data`（hex）。
- 结果按时间倒序：遇到早于 `--start` 的交易即可终止翻页。
- 只覆盖 TRX 原生转账（`TransferContract`）；TRC20/USDT 走 `/v1/accounts/{addr}/transactions/trc20`，金额需按代币 decimals 换算，不要混用。

过滤参数（可任意组合）：
- 精确：`--amount 12.34`（TRX）或 `--amount-sun 154`；范围：`--min-trx/--max-trx`（或 `--min-sun/--max-sun`）
- 方向：`--direction in|out|all`（owner == 查询地址为 out）
- `--memo-substr`、`--start/--end`（`YYYY-MM-DD` 按 UTC 且 end 含当天；也接受 ISO8601/毫秒时间戳）
- `--limit N`（命中条数）、`--max-pages`、`--json`、`--full`、`--include-failed`

```bash
node /workspace/tron-memo-tx/memo-tx.js query --net main \
  --address T收款地址 --amount 12.583 --start 2026-11-01 --json
```

关键实现要点：
- **无 API key 时公共节点频繁 429**：对 429 与 5xx 做指数退避重试（如 1.5s/3s），高频使用设置 `TRONGRID_API_KEY` 请求头。
- 金额比较一律用 sun 整数；TRX 输入先 `Math.round(x * 1e6)`，禁止浮点直接比较。
- memo hex 解码后需区分可读文本与二进制（不可打印则显示 `[binary N bytes]`）。
- 整额（如恰好 100 TRX）重复极多，认款务必用唯一零头 + 时间窗口 + memo 多重判定。

## 5. 参考脚本子命令（/workspace/tron-memo-tx/memo-tx.js）

| 命令 | 作用 | 联网 | 需私钥 |
|---|---|---|---|
| `balance --address` | 查余额 | 是 | 否 |
| `build --from --to --amount-sun --memo --out` | 构造未签名交易 JSON | 是 | 否 |
| `sign --in --out` | 离线签名（校验 owner、有效期） | 否 | 是 |
| `broadcast --in` | 广播并自动 wait（`--no-wait` 关闭） | 是 | 否 |
| `wait --id` | 轮询确认 | 是 | 否 |
| `query --address [金额/方向/memo/时间]` | 流水过滤/认款 | 是 | 否 |
| `run` | 在线模式四步合一 | 是 | 是 |

冷钱包流程：联网机 `build` →（U盘/二维码）离线机 `sign` → 联网机 `broadcast`，私钥永不触网。

## 常见错误对照表

| 错误 | 原因 | 处理 |
|---|---|---|
| `SIGERROR ... not contained of permission` | 手拼 protobuf / 签名者与 owner 不一致 | 用 transactionBuilder 重建；签名前比对地址 |
| `Invalid URL provided to HttpProvider` | tronweb v6 fullHost 非法（如端口 0） | 离线签名也给合法占位 URL `http://127.0.0.1:1` |
| `Transaction reference block not found` | TAPOS 引用块过期（约 60 秒） | 重新 build → sign → 立即广播 |
| 广播返回 `result:false` / `CONTRACT_VALIDATE_ERROR` | 余额不足/地址未激活/重复/签名错 | hex 解码 message，修正后再发；勿当成功 |
| HTTP 429 / 5xx | 公共节点限流抖动 | 指数退避重试；必要时配 TRONGRID_API_KEY |
| 已上链但 `contractRet` 非 SUCCESS | TRC20 合约执行失败 | 查授权额度/能量，不当作到账 |
| 区块 RPC 里找不到 `data` | `getblockbynum` 的交易字段名是 `transactions` | 遍历 `block.transactions` |

## 禁止事项

- 不预测博彩/老虎机类结果，不为赌博平台提供任何"触发预测"工具；本技能只做真实链上数据与交易。
- 不硬编码私钥、不跳过主网确认、不在超时后盲目重发交易。
