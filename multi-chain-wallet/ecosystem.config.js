/**
 * PM2 常驻服务配置
 *
 * 用法:
 *   pm2 start ecosystem.config.js                  # 启动所有监听服务
 *   pm2 start ecosystem.config.js --only listen-tron  # 只启动 TRON 监听
 *   pm2 logs listen-tron                            # 查看实时日志
 *   pm2 restart ecosystem.config.js                 # 重启所有
 *   pm2 delete ecosystem.config.js                  # 停止并删除
 *   pm2 save                                        # 保存进程列表（开机自启）
 *   pm2 startup                                     # 生成开机自启命令
 */

module.exports = {
  apps: [
    {
      name: 'listen-tron',
      script: './listen-wallet.js',
      args: [
        '--chain', 'tron',
        // ===== 必填：监听地址或私钥（二选一）=====
        '--address', process.env.LISTEN_ADDRESS || 'TXKRaDanNVNhXKNWTHZ24vED3wuP2J7N4t',
        // '--pk', '你的私钥',
        // ===== 实时模式（推荐）=====
        '--ws',
        // ===== 到账通知（蜂鸣+桌面通知）=====
        '--notify',
        // ===== 通知金额阈值（仅 >= 此值才通知，DB 仍全量记录）=====
        '--min-amount', process.env.MIN_AMOUNT || '0',
        // ===== SQLite 数据库记录所有到账交易 =====
        '--db', process.env.DB_PATH || './data/transactions.db',
        // ===== 定时自动导出 CSV（每 N 小时，0=关闭）=====
        '--auto-export', process.env.AUTO_EXPORT_HOURS || '24',
        // ===== Telegram 推送（需同时设置 TELEGRAM_BOT_TOKEN 和 TELEGRAM_CHAT_ID 环境变量）=====
        '--telegram-token', process.env.TELEGRAM_BOT_TOKEN || '',
        '--telegram-chat-id', process.env.TELEGRAM_CHAT_ID || '',
        // ===== 可选：API Key 提高限流 =====
        // '--tronscan-key', process.env.TRONSCAN_API_KEY || '',
        // '--trongrid-key', process.env.TRONGRID_API_KEY || '',
        // ===== 可选：到账 webhook 回调 =====
        // '--webhook', process.env.WEBHOOK_URL || '',
      ],
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,          // 崩溃自动重启
      max_restarts: 10,
      restart_delay: 3000,
      watch: false,
      max_memory_restart: '200M',
      env: {
        NODE_ENV: 'production',
        // 代理（沙箱环境需要，生产环境按需去掉）
        HTTPS_PROXY: process.env.HTTPS_PROXY || '',
        HTTP_PROXY: process.env.HTTP_PROXY || '',
        // Telegram 推送凭据（用户自行在服务器环境变量中设置，不在对话中传递）
        TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
        TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
      },
      error_file: './logs/listen-tron-error.log',
      out_file: './logs/listen-tron-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
    {
      name: 'listen-bsc',
      script: './listen-wallet.js',
      args: [
        '--chain', 'bsc',
        '--address', process.env.LISTEN_BSC_ADDRESS || '0x0000000000000000000000000000000000000000',
        '--ws',
      ],
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      watch: false,
      max_memory_restart: '200M',
      env: {
        NODE_ENV: 'production',
      },
      error_file: './logs/listen-bsc-error.log',
      out_file: './logs/listen-bsc-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
  ],
};
