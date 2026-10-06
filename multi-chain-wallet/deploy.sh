#!/usr/bin/env bash
# ============================================================
# 钱包监听服务 — 一键部署脚本
# 适用于: Ubuntu 20.04+ / Debian 11+
# 用法: bash deploy.sh [--no-node] [--no-pm2] [--skip-env]
# ============================================================
set -euo pipefail

# ---------- 颜色输出 ----------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}   $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
fail()  { echo -e "${RED}[FAIL]${NC} $*"; exit 1; }

# ---------- 参数解析 ----------
SKIP_NODE=0; SKIP_PM2=0; SKIP_ENV=0
for arg in "$@"; do
  case "$arg" in
    --no-node)   SKIP_NODE=1 ;;
    --no-pm2)    SKIP_PM2=1 ;;
    --skip-env)  SKIP_ENV=1 ;;
    -h|--help)
      echo "用法: bash deploy.sh [选项]"
      echo "  --no-node    跳过 Node.js 安装"
      echo "  --no-pm2     跳过 PM2 安装"
      echo "  --skip-env   跳过 .env 配置引导"
      exit 0
      ;;
  esac
done

# ---------- 工作目录 ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
info "项目目录: $SCRIPT_DIR"

# ---------- 1. 系统检测 ----------
info "========== 1. 系统环境检测 =========="
if ! command -v apt-get &>/dev/null; then
  fail "本脚本仅支持 Debian/Ubuntu 系（apt）。CentOS 请参考 DEPLOY.md 手动部署。"
fi
. /etc/os-release
info "操作系统: $PRETTY_NAME"

# 必须以 root 或 sudo 运行
if [[ $EUID -ne 0 ]]; then
  warn "当前非 root 用户，部分操作需 sudo 权限"
  SUDO="sudo"
else
  SUDO=""
fi

# ---------- 2. 安装编译工具链 ----------
info "========== 2. 安装编译工具链 =========="
$SUDO apt-get update -qq
$SUDO apt-get install -y -qq curl git python3 make g++ build-essential
ok "编译工具链已安装"

# ---------- 3. 安装 Node.js ----------
if [[ $SKIP_NODE -eq 0 ]]; then
  info "========== 3. 安装 Node.js =========="
  if command -v node &>/dev/null && [[ $(node -v | sed 's/v//' | cut -d. -f1) -ge 18 ]]; then
    ok "Node.js 已满足要求: $(node -v)"
  else
    info "未检测到 Node.js ≥ 18，通过 nvm 安装 Node 20..."
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    export NVM_DIR="$HOME/.nvm"
    # shellcheck disable=SC1091
    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
    nvm install 20
    nvm use 20
    nvm alias default 20
    ok "Node.js 安装完成: $(node -v)"
  fi
else
  info "========== 3. 跳过 Node.js 安装 =========="
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
fi

NODE_BIN="$(command -v node || echo "$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node 2>/dev/null | head -1)/bin/node")"
NPM_BIN="$(command -v npm || echo "${NODE_BIN%node}npm")"

# ---------- 4. 安装项目依赖 ----------
info "========== 4. 安装项目依赖 =========="
if [[ ! -f package.json ]]; then
  fail "未找到 package.json，请确认在项目目录下运行"
fi
"$NPM_BIN" install --no-audit --no-fund
ok "项目依赖安装完成"

# ---------- 5. 配置 .env ----------
if [[ $SKIP_ENV -eq 0 ]]; then
  info "========== 5. 配置 .env =========="
  if [[ -f .env ]]; then
    ok ".env 已存在，跳过生成"
  else
    cp .env.example .env
    warn "已从模板生成 .env，请按提示填写关键配置"

    # 交互式填写监听地址
    read -rp "请输入 TRON 监听地址 [默认: TXKRaDanNVNhXKNWTHZ24vED3wuP2J7N4t]: " LISTEN_ADDR
    LISTEN_ADDR="${LISTEN_ADDR:-TXKRaDanNVNhXKNWTHZ24vED3wuP2J7N4t}"
    sed -i "s|^LISTEN_ADDRESS=.*|LISTEN_ADDRESS=$LISTEN_ADDR|" .env

    # 交互式填写 Telegram
    read -rp "是否配置 Telegram 推送? [y/N]: " TG_CONFIRM
    if [[ "$TG_CONFIRM" =~ ^[Yy]$ ]]; then
      read -rp "请输入 Telegram Bot Token: " TG_TOKEN
      read -rp "请输入 Telegram Chat ID: " TG_CHAT_ID
      sed -i "s|^TELEGRAM_BOT_TOKEN=.*|TELEGRAM_BOT_TOKEN=$TG_TOKEN|" .env
      sed -i "s|^TELEGRAM_CHAT_ID=.*|TELEGRAM_CHAT_ID=$TG_CHAT_ID|" .env
    fi

    # 可选：代理
    read -rp "是否需要配置代理（国内服务器）? [y/N]: " PROXY_CONFIRM
    if [[ "$PROXY_CONFIRM" =~ ^[Yy]$ ]]; then
      read -rp "请输入 HTTPS 代理地址 (如 http://127.0.0.1:7890): " PROXY_URL
      sed -i "s|^HTTPS_PROXY=.*|HTTPS_PROXY=$PROXY_URL|" .env
      sed -i "s|^HTTP_PROXY=.*|HTTP_PROXY=$PROXY_URL|" .env
    fi

    ok ".env 配置完成"
    echo "  LISTEN_ADDRESS     = $LISTEN_ADDR"
    echo "  Telegram 推送      = $([[ "$TG_CONFIRM" =~ ^[Yy]$ ]] && echo '已配置' || echo '未配置')"
  fi
else
  info "========== 5. 跳过 .env 配置 =========="
fi

# 校验 .env 中监听地址
LISTEN_VAL="$(grep -E '^LISTEN_ADDRESS=' .env | cut -d= -f2)"
if [[ -z "$LISTEN_VAL" || "$LISTEN_VAL" == "你的监听地址" ]]; then
  warn ".env 中 LISTEN_ADDRESS 未设置有效地址，服务可能无法正常监听"
fi

# ---------- 6. 安装 PM2 ----------
if [[ $SKIP_PM2 -eq 0 ]]; then
  info "========== 6. 安装 PM2 =========="
  if command -v pm2 &>/dev/null; then
    ok "PM2 已安装: $(pm2 --version)"
  else
    "$NPM_BIN" install -g pm2 --no-audit --no-fund
    ok "PM2 安装完成: $(pm2 --version)"
  fi
else
  info "========== 6. 跳过 PM2 安装 =========="
fi

PM2_BIN="$(command -v pm2 || echo "${NODE_BIN%node}pm2")"

# ---------- 7. 创建数据与日志目录 ----------
info "========== 7. 初始化目录 =========="
mkdir -p data logs
ok "data/ 和 logs/ 目录就绪"

# ---------- 8. 启动服务 ----------
info "========== 8. 启动监听服务 =========="
# 先删除同名旧进程（避免报错）
"$PM2_BIN" delete listen-tron &>/dev/null || true
"$PM2_BIN" start ecosystem.config.js --only listen-tron

sleep 3
STATUS="$("$PM2_BIN" jlist | grep -o '"name":"listen-tron"[^}]*"pm2_env":{"status":"[^"]*"' | grep -o '"status":"[^"]*"' | head -1)"
if [[ "$STATUS" == *'"status":"online"'* ]]; then
  ok "listen-tron 服务已启动 (online)"
else
  fail "listen-tron 启动失败，请执行: pm2 logs listen-tron"
fi

# ---------- 9. 设置开机自启 ----------
info "========== 9. 配置开机自启 =========="
# 保存进程列表
"$PM2_BIN" save

# 检测是否已配置 systemd 自启
if systemctl is-enabled pm2-root &>/dev/null || systemctl is-enabled pm2-"$USER" &>/dev/null; then
  ok "PM2 开机自启已配置"
else
  warn "正在配置开机自启（如提示命令请复制执行）..."
  "$PM2_BIN" startup systemd | tee /tmp/pm2-startup.log
  STARTUP_CMD="$(grep -oE 'sudo.*pm2 startup systemd.*' /tmp/pm2-startup.log | head -1 || true)"
  if [[ -n "$STARTUP_CMD" ]]; then
    info "请手动执行以下命令完成开机自启:"
    echo "  $STARTUP_CMD"
    echo "  pm2 save"
  fi
fi

# ---------- 10. 验证 ----------
info "========== 10. 部署验证 =========="
echo "----------------------------------------"
"$PM2_BIN" list 2>/dev/null | grep -E "listen-tron|name|status" || true
echo "----------------------------------------"
info "最近日志:"
"$PM2_BIN" logs listen-tron --lines 15 --nostream 2>/dev/null || true
echo "----------------------------------------"

# ---------- 完成 ----------
echo ""
ok "🎉 部署完成！"
echo ""
echo "常用命令:"
echo "  pm2 logs listen-tron              # 实时日志"
echo "  pm2 restart listen-tron           # 重启（修改 .env 后执行）"
echo "  pm2 list                          # 进程列表"
echo "  pm2 monit                         # 资源监控"
echo ""
echo "数据库操作:"
echo "  node listen-wallet.js --db ./data/transactions.db --stats"
echo "  node listen-wallet.js --db ./data/transactions.db --export-csv ./data/export.csv"
echo ""
echo "Telegram 凭据如需补充，请编辑 .env 后执行: pm2 restart listen-tron"
