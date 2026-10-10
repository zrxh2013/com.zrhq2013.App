---
name: "start-preview"
description: "检测并拉起本工作区 8899 端口的手机网页预览服务（/workspace/preview），验证 200 后给出 http://localhost:8899 入口。当用户说 localhost:8899 打不开、无法访问、请启动服务、重启预览时调用。"
---

# 启动闪应用预览服务

把工作区里 `/workspace/preview` 的静态预览页（手机外壳 + iframe 内嵌灵光页面）通过本地 HTTP 服务在 **8899** 端口提供访问。

## 触发条件

当出现以下任一情况时执行本技能：

- 用户反馈 `http://localhost:8899` 打不开 / 无法访问 / 连接被拒绝
- 用户要求「启动服务」「重启预览」「预览又挂了」
- 需要向用户交付该预览入口前，先确认服务在线

## 执行步骤

1. **检测端口与进程**（先诊断，不要盲目重复启动）：

   ```bash
   ss -ltnp 2>/dev/null | grep 8899 || echo "8899 not listening"
   ps aux | grep "http.server 8899" | grep -v grep || echo "no server process"
   ```

2. **若未监听则拉起服务**。优先使用工作区自带脚本（幂等，内部会先检测端口）：

   ```bash
   /workspace/preview/start.sh
   ```

   若脚本不存在，手动执行等价命令（必须 `setsid` + 脱离 stdio，防止随终端/会话退出被杀）：

   ```bash
   cd /workspace/preview && \
   setsid nohup python3 -m http.server 8899 --bind 0.0.0.0 \
     > /tmp/preview-server.log 2>&1 < /dev/null &
   ```

3. **验证服务可用**（以客观证据闭环，不能只凭启动命令退出码）：

   ```bash
   ss -ltn | grep 8899
   curl -sI http://localhost:8899 | head -1      # 期望 HTTP/1.0 200 OK
   ```

4. **交付入口**：明确告诉用户访问 `http://localhost:8899`；如环境支持 OpenPreview，同时调用它打开预览。

## 故障处理

- **端口被别的进程占用**：先用 `ss -ltnp | grep 8899` 确认占用者；若是历史残留的 python http.server 可直接结束后重新拉起，不要漂移到其它端口（交付 URL 必须始终固定为 8899）。
- **启动失败**：查看 `/tmp/preview-server.log`；常见原因为 `/workspace/preview/index.html` 缺失或端口被占。
- **目录/文件缺失**：`/workspace/preview` 应至少包含 `index.html`（预览页）和 `start.sh`（启动脚本）；缺失时需先恢复再启动。

## 重要边界

- 沙箱（远程环境）重启后所有后台进程必然被清空，且环境内通常没有 crontab/systemd，**无法配置开机自启**。每次环境重置后服务掉线属正常现象，按上述步骤重新拉起即可，并在回复中如实说明这一环境限制，不要承诺「以后不会再掉」。
- 该服务仅用于预览，不要用于生产用途；不要在技能相关文件中写入任何凭据或私有地址。
