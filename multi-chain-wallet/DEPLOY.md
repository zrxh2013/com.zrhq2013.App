# TRON/BSC 钱包监听服务 — VPS 部署指南

## 一、服务器要求

| 项目 | 最低要求 | 说明 |
|------|---------|------|
| 系统 | Ubuntu 20.04+ / Debian 11+ / CentOS 8+ | 推荐 Ubuntu 22.04 |
| 配置 | 1 核 1G | 监听服务资源占用极低 |
| 带宽 | 1 Mbps | 仅轮询 API，流量很小 |
| 地区 | **海外**（必须） | 需要能访问 `api.telegram.org` 和 `apilist.tronscanapi.com` |
| 存储 | 10 GB | SQLite 数据库增长缓慢 |

> ⚠️ 国内服务器无法直连 Telegram，若必须用国内服务器需配置代理（在 `.env` 中设置 `HTTPS_PROXY`）。

---

## 二、安装系统依赖

`better-sqlite3` 是原生模块，需要编译工具链。

### Ubuntu / Debian
```bash
apt update
apt install -y curl git python3 make g++ build-essential
```

### CentOS / RHEL
```bash
yum install -y curl git python3 make gcc gcc-c++
```

---

## 三、安装 Node.js（推荐 v18 或以上）

### 方式 A：使用 nvm（推荐，方便多版本管理）
```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 20
nvm use 20
node -v   # 确认版本
npm -v
```

### 方式 B：使用 NodeSource（系统级安装）
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
node -v
```

---

## 四、上传项目代码

### 方式 A：从 Git 仓库克隆
```bash
cd /opt
git clone <你的仓库地址> multi-chain-wallet
cd multi-chain-wallet
```

### 方式 B：本地打包上传
在本地项目目录执行：
```bash
tar --exclude='node_modules' --exclude='.env' --exclude='data/*.db' --exclude='logs' -czf wallet-monitor.tar.gz .
```
上传到 VPS 后解压：
```bash
scp wallet-monitor.tar.gz root@<VPS_IP>:/opt/
ssh root@<VPS_IP>
cd /opt && mkdir -p multi-chain-wallet && tar -xzf wallet-monitor.tar.gz -C multi-chain-wallet
cd multi-chain-wallet
```

---

## 五、安装项目依赖

```bash
cd /opt/multi-chain-wallet
npm install --production --no-audit --no-fund
```

> `--production` 可跳过 devDependencies，减小体积。本项目无 devDependencies，加不加都行。

---

## 六、配置环境变量

```bash
cp .env.example .env
nano .env
```

### 必填项

| 变量 | 说明 |
|------|------|
| `LISTEN_ADDRESS` | 要监听的 TRON 地址（Base58 格式） |

### Telegram 推送（强烈建议填写）

| 变量 | 说明 |
|------|------|
| `TELEGRAM_BOT_TOKEN` | @BotFather 创建 Bot 后获取的 Token |
| `TELEGRAM_CHAT_ID` | 接收推送的 Chat ID（个人正数 / 群组负数） |

### 可选配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MIN_AMOUNT` | `0` | 仅金额 ≥ 此值才通知（DB 仍全量记录） |
| `DB_PATH` | `./data/transactions.db` | SQLite 数据库路径 |
| `AUTO_EXPORT_HOURS` | `24` | 自动导出 CSV 间隔（小时），0=关闭 |
| `LISTEN_BSC_ADDRESS` | 零地址 | BSC 监听地址（仅启用 listen-bsc 时填） |
| `TRONSCAN_API_KEY` | 空 | 提高 TronScan 限流额度 |
| `TRONGRID_API_KEY` | 空 | 启用事件 WebSocket 时需要 |
| `WEBHOOK_URL` | 空 | 到账时 POST 回调 URL |
| `HTTPS_PROXY` / `HTTP_PROXY` | 空 | 代理地址（国内服务器需要） |

> 💡 获取 Bot Token 和 Chat ID 的方法见文末「附录」。

---

## 七、安装并使用 PM2

### 全局安装 PM2
```bash
npm install -g pm2
pm2 --version
```

### 启动 TRON 监听
```bash
cd /opt/multi-chain-wallet
pm2 start ecosystem.config.js --only listen-tron
```

### （可选）同时启动 BSC 监听
```bash
# 先在 .env 中填入 LISTEN_BSC_ADDRESS
pm2 start ecosystem.config.js --only listen-bsc
```

### 查看运行状态
```bash
pm2 list                # 进程列表
pm2 logs listen-tron    # 实时日志
pm2 logs listen-tron --lines 50 --nostream   # 查看最近 50 行日志
```

---

## 八、设置开机自启

```bash
# 1. 生成开机自启命令（会输出一行命令，复制执行）
pm2 startup systemd

# 按提示复制执行输出的命令，例如：
# sudo env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u root --hp /root

# 2. 保存当前进程列表
pm2 save
```

重启服务器后验证：
```bash
reboot
# 重新登录后
pm2 list   # 确认 listen-tron 仍为 online
```

---

## 九、验证服务是否正常

### 1. 确认进程在线
```bash
pm2 list | grep listen-tron
# 应显示 status: online
```

### 2. 查看启动日志
```bash
pm2 logs listen-tron --lines 20 --nostream
# 应看到 "监听转入 + 转出交易..."
```

### 3. 测试 Telegram 推送（可选）
```bash
# 用你的 Bot Token 和 Chat ID 发送测试消息
curl -s "https://api.telegram.org/bot<你的TOKEN>/sendMessage" \
  -d "chat_id=<你的CHAT_ID>" \
  -d "text=✅ 钱包监听服务已部署成功！"
```

### 4. 测试到账通知
向监听地址转入一笔小额 TRX（如 1 TRX），观察：
```bash
pm2 logs listen-tron
# 应看到交易详情和 "💰 收到新交易" 通知
```

---

## 十、日常运维命令

```bash
pm2 logs listen-tron                # 实时日志
pm2 restart listen-tron             # 重启（修改 .env 后必须重启）
pm2 stop listen-tron                # 停止
pm2 delete listen-tron              # 删除进程
pm2 monit                           # 资源监控面板

# 数据库查询
cd /opt/multi-chain-wallet
node listen-wallet.js --db ./data/transactions.db --query --from 2026-01-01 --to 2026-12-31

# 导出 CSV
node listen-wallet.js --db ./data/transactions.db --export-csv ./data/export.csv

# 金额统计
node listen-wallet.js --db ./data/transactions.db --stats
```

---

## 十一、常见问题

### Q1: `Error: Cannot find module 'better-sqlite3'` 或编译失败
```bash
# 缺少编译工具，重新安装
apt install -y python3 make g++ build-essential
npm rebuild better-sqlite3
```

### Q2: Telegram 推送收不到
```bash
# 测试网络连通性
curl -s "https://api.telegram.org/bot<TOKEN>/getMe"
# 若超时，说明服务器无法访问 Telegram，需配置代理或换海外服务器
```

### Q3: 轮询出错 401 / 403
TronScan 公共 API 限流。可申请免费 API Key 填入 `TRONSCAN_API_KEY`，或忽略（自动重试）。

### Q4: 修改 `.env` 后不生效
PM2 不会自动重新加载 `.env`，必须重启：
```bash
pm2 restart listen-tron
```

### Q5: 服务器重启后服务没起来
```bash
pm2 resurrect       # 手动恢复
pm2 startup         # 重新设置开机自启
pm2 save
```

---

## 附录：获取 Telegram Bot Token 和 Chat ID

### 获取 Bot Token
1. Telegram 搜索 **@BotFather** 并打开
2. 发送 `/newbot`
3. 输入显示名称（如 `钱包到账提醒`）
4. 输入用户名（须以 `bot` 结尾，如 `my_wallet_alert_bot`）
5. 复制返回的 Token（格式：`123456:ABC-DEF...`）

### 获取 Chat ID
- **个人**：搜索 **@userinfobot**，发送任意消息，返回的 `Id` 即 Chat ID
- **群组**：把 Bot 拉入群组并发条消息，然后浏览器访问：
  ```
  https://api.telegram.org/bot<TOKEN>/getUpdates
  ```
  返回 JSON 中 `chat.id`（负数，通常以 `-100` 开头）即群组 Chat ID

### 验证凭据
```bash
curl -s "https://api.telegram.org/bot<TOKEN>/sendMessage" \
  -d "chat_id=<CHAT_ID>" \
  -d "text=配置验证成功"
```
返回 `"ok":true` 即为正确。

---

## 部署检查清单

- [ ] 服务器为海外节点（能访问 Telegram）
- [ ] 已安装 Node.js v18+
- [ ] 已安装编译工具（python3, make, g++）
- [ ] 项目代码已上传
- [ ] `npm install` 执行成功
- [ ] `.env` 已填写 `LISTEN_ADDRESS`
- [ ] `.env` 已填写 `TELEGRAM_BOT_TOKEN` 和 `TELEGRAM_CHAT_ID`
- [ ] `pm2 start ecosystem.config.js --only listen-tron` 启动成功
- [ ] `pm2 list` 显示 status 为 online
- [ ] 日志显示「监听转入 + 转出交易...」
- [ ] 已执行 `pm2 startup` + `pm2 save` 设置开机自启
