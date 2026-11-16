---
name: "android-emulator-container-setup"
description: "Bootstrap Android SDK/adb and a headless emulator in KVM-less, 4GB cgroup-limited Linux containers. Invoke when container was reset or user asks to install SDK/adb/emulator/AVD and launch an Android emulator."
---

# 受限容器内 Android SDK、模拟器与 WebView 验证

适用于**无 KVM、4GB cgroup 内存上限、无显示器、会整体重置**的 Linux 沙箱。目标是恢复
SDK，构建 APK，以 TCG 启动模拟器，并通过 adb + CDP 验证 WebView 中的真实 H5 渲染。

## 1. 一键恢复入口

`/workspace` 通常跨重置保留；`/opt/android-sdk`、`~/.android/avd`、`/tmp`、apt 包和
`/usr/local/bin` 软链接可能丢失。先检查真实状态，不要假设环境仍存在。

```bash
command -v adb
ls -ld /opt/android-sdk /root/.android/avd 2>/dev/null
ls -d /root/.local/share/mise/installs/java/17*
cat /sys/fs/cgroup/memory.max
cat /sys/fs/cgroup/memory.current
```

本工作区的持久化恢复入口：

```bash
setsid bash /workspace/.android-bootstrap/recover.sh </dev/null >/dev/null 2>&1 &
```

进度与日志：

```bash
cat /workspace/.android-bootstrap/fast-stage
tail -30 /workspace/.android-bootstrap/fast-sdk.log
tail -30 /workspace/.android-bootstrap/boot.log
tail -30 /workspace/.android-bootstrap/recover.log
```

`recover.sh` 依次调用 `fast-sdk.sh`、启动模拟器、执行 `boot-wait.sh`、安装现有 APK、启动应用并
建立 CDP forward。若源码刚修改过，先按第 4 节重新构建 APK，再执行恢复；不要在模拟器运行时构建。

## 2. SDK 恢复：腾讯镜像 + sdkmanager

使用 `fast-sdk.sh`，不要回退到手动解包 platform-tools 的旧路线。镜像中的部分组件 zip 不含
`package.xml`，手工还原目录会出现 `FATAL:no_pkgxml...`。

核心配置：

```bash
BASE="https://mirrors.cloud.tencent.com/AndroidSDK"
SDK=/opt/android-sdk
export JAVA_HOME=$(ls -d /root/.local/share/mise/installs/java/17*/ 2>/dev/null | head -1)
export ANDROID_HOME=$SDK ANDROID_SDK_ROOT=$SDK
export SDK_TEST_BASE_URL="$BASE/"   # 结尾斜杠必须保留
SDKM=$SDK/cmdline-tools/latest/bin/sdkmanager
PX="--proxy=http --proxy_host=127.0.0.1 --proxy_port=18080"
yes | $SDKM $PX --licenses
yes | $SDKM $PX "platform-tools" "platforms;android-34" \
  "build-tools;34.0.0" "emulator" "system-images;android-30;default;x86_64"
```

要点：

- sdkmanager 和 Gradle 均使用 JDK 17；不要用沙箱默认的 JDK 25。
- `SDK_TEST_BASE_URL` 缺少结尾 `/` 会回退到慢速 Google 源。
- cmdline-tools 下载前先 `mkdir -p $SDK/cmdline-tools /tmp/sdk-zips`，避免重置后目录不存在。
- apt 检查要覆盖 `unzip libxcomposite1 libxtst6 libegl1` 等关键包；缺失时先 `apt-get update`。
- 保留 `/usr/local/bin` 的 adb/emulator/sdkmanager 软链接，非交互 shell 不会可靠读取 profile。

## 3. AVD 与 TCG 启动参数

选用 API 30 default x86_64。API 34 镜像会提高 guest RAM，在 4GB cgroup 中容易 OOM。
当前稳定配置由 `fast-sdk.sh` 写入：

```ini
hw.ramSize = 2048
vm.heapSize = 192
hw.cpu.ncore = 1
hw.lcd.width = 540
hw.lcd.height = 960
hw.lcd.density = 240
hw.lcd.vsync = 30
hw.bluetoothSupport = no
hw.gpu.enabled = yes
hw.gpu.mode = auto
disk.dataPartition.size = 4096M
```

删除旧配置中的同名单行键后再追加，并清理 `hardware-qemu.ini*`，避免重复键和旧缓存。
单核比多核 TCG 更稳定；不要为了“加速”改成双核或增加 RAM。

启动统一使用 `run-emulator.sh`：

```bash
export ANDROID_I_WANT_MY_TCG=yes
export LD_LIBRARY_PATH=/opt/android-sdk/emulator/lib64:$LD_LIBRARY_PATH
exec /opt/android-sdk/emulator/emulator -avd aosp30 \
  -no-window -no-audio -no-boot-anim -no-snapshot \
  -accel off -netdelay none -netspeed full -no-metrics
```

无 KVM 的关键是 `ANDROID_I_WANT_MY_TCG=yes` 和 `-accel off`。冷启动与 H5 执行都较慢；
System UI ANR 时选择 Wait。540×960 下可尝试 `adb shell input tap 182 573`。

`boot-wait.sh` 负责等待启动并设置：

- guest 代理 `10.0.2.2:18080`；
- `device_provisioned=1`、`user_setup_complete=1`；
- 动画缩放 0、关闭安装校验、常亮、关闭蓝牙、取消 keyguard。

## 4. 4GB 内存下的 Gradle 构建

**先关闭模拟器，再构建。**

```bash
adb emu kill
cat /sys/fs/cgroup/memory.current
```

在 `/workspace` 使用 JDK 17、阿里云 Maven 镜像、单 worker 和受限堆内存：

```bash
JAVA_HOME=/root/.local/share/mise/installs/java/17.0.20+101 \
ANDROID_HOME=/opt/android-sdk \
ANDROID_SDK_ROOT=/opt/android-sdk \
GRADLE_OPTS="-Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=18080 -Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=18080" \
./gradlew assembleDebug --no-daemon \
  --init-script .android-bootstrap/mirror.init.gradle \
  -Dorg.gradle.jvmargs="-Xmx1280m -XX:MaxMetaspaceSize=512m" \
  -Dorg.gradle.workers.max=1
```

JDK 小版本可能变化，先用 glob 查明实际路径。`mirror.init.gradle` 同时覆盖插件仓库和依赖仓库，
前置阿里云 `gradle-plugin/google/public`。wrapper 缓存可能随重置丢失，重新下载时也必须走可用代理。

项目显式使用 `buildToolsVersion '34.0.0'`，避免 AGP 自动从 Google 源安装旧 Build-Tools。
APK 输出：`/workspace/app/build/outputs/apk/debug/app-debug.apk`。

## 5. 安装故障与干净启动

常规安装：

```bash
bash /workspace/.android-bootstrap/boot-wait.sh
adb install -r /workspace/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.zrhq2013.app/.MainActivity
```

沙箱重置可能生成新的 debug keystore。若出现 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`，这是签名
不匹配，不是 APK 损坏；测试场景可卸载旧包后安装（会清除应用数据）：

```bash
adb uninstall com.zrhq2013.app
adb install /workspace/app/build/outputs/apk/debug/app-debug.apk
```

系统服务故障要按真实日志区分：

- `DeviceStorageMonitorService ... StorageManager.getWritablePrivateVolumes() on a null object`
  并伴随 system_server 重启：冷重启模拟器，不要反复重装 APK。
- 冷重启后可在 `service check package` 首次 `found` 时尝试尽早安装；但 binder 名称出现不代表
  所有内部服务已就绪。
- 若尽早安装出现 `PackageManagerInternal ... on a null object reference`，说明仍过早，改等
  `boot-wait.sh` 完成、package service 稳定后再安装。
- `Can't find service: package/activity/settings` 的瞬时值应结合 boot 状态和后续检查判断。

高负载下 `adb exec-out screencap` 可能得到截断 PNG，可靠截图方式：

```bash
adb shell screencap -p /sdcard/app.png
adb pull /sdcard/app.png /workspace/app.png
```

## 6. 本项目 WebView / Chrome 83 兼容要点

API 30 镜像内置 WebView 为 Chrome 83。补丁位于：

- `app/src/main/assets/polyfill.js`
- `app/src/main/java/com/zrhq2013/app/MainActivity.java`

### 6.1 JavaScript 与 cookie

`polyfill.js` 提供 `AggregateError`、`Promise.any`、`Object.hasOwn`、`replaceAll`、`.at()`、
`findLast`、`structuredClone` 等基础兼容。H5 安全 SDK 会把 `document.cookie` 改成恒空
getter/false setter；必须在业务脚本前安装原生 cookie 访问器锁，否则 ctoken/APDID 无法维持，
业务请求会一直等待。

通过 `WebViewFeature.DOCUMENT_START_SCRIPT` 注入主文档，并显式启用：

```java
CookieManager.getInstance().setAcceptCookie(true);
CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);
```

### 6.2 跨域 iframe

实测 `DOCUMENT_START_SCRIPT` 和 CDP `Page.addScriptToEvaluateOnNewDocument` 都不能可靠覆盖当前
`uniocontent.com/v1/shim.html` 跨域 iframe。有效方案是 `shouldInterceptRequest` 只拦截需要的
跨域 HTML，在 `<head>` 起始处内联插入同一个 polyfill。

注意：

- 非 GET、非 HTML、普通 JS/CSS bundle 返回 `null`，不要全站代理页面资源。
- Java `HttpURLConnection` 不会自动使用 WebView 系统代理；启动时从
  `Settings.Global.HTTP_PROXY` 读取代理并设置 Java `http(s).proxyHost/proxyPort`。
- `shouldInterceptRequest` 在后台线程执行，禁止调用 `webView.getSettings()` 等 WebView 方法。
  UA 必须在主线程提前缓存为字符串。
- 注入后移除旧 `Content-Length`、`Content-Encoding`、`Transfer-Encoding`，保留正确 MIME/charset。
- 将业务 cookie 带给请求，并把 `Set-Cookie` 写回 CookieManager。

### 6.3 antd 残留加载图标

Chrome 83 不支持 antd 5 动态 CSS 使用的 `:where()`（Chrome 88 起支持）。业务样式又把加载容器
固定为 `display:flex`，因此 `aria-busy=false` 后图标仍可能覆盖答案。

本项目使用窄范围补偿，而不是隐藏整个答案容器：

```css
.ant-spin[aria-busy="false"] > .ant-spin-dot { display: none !important; }
```

该规则只隐藏已结束加载器的直接子图标，不影响 `aria-busy=true` 的加载状态，也不影响
nested-loading 的正文。不要把它误当成完整的 `:where()` polyfill。

## 7. CDP 主页面、子框架与网络诊断

应用已调用 `WebView.setWebContentsDebuggingEnabled(true)`。连接当前进程：

```bash
PID=$(adb shell pidof com.zrhq2013.app | tr -d '\r')
adb forward tcp:9333 localabstract:webview_devtools_remote_$PID
curl -s http://127.0.0.1:9333/json/list
```

零依赖工具均在 `/workspace/.android-bootstrap/`：

```bash
# 主页面运行时与 DOM
node cdp-eval.js 9333 expr-inspect.js
node cdp-eval.js 9333 expr-dom.js
node cdp-eval.js 9333 expr-frames.js

# 跨域答案 iframe（按 origin 关键字选择 execution context）
node cdp-frame-eval.js 9333 uniocontent expr-iframe.js

# 请求、响应、失败与长期 pending
node cdp-net.js 9333 60
```

诊断时区分文档中间态与稳定状态：`readyState=loading`、`body=null`、旧帧截图都不能用于判断修复
是否成功。不要为验证而频繁 reload；先等待当前文档完成，并同时检查主页面和 iframe。

## 8. 验证清单与兼容边界

稳定渲染至少核对：

1. 主页面标题、用户聊天气泡和“灵光｜在App中打开”按钮存在。
2. `uniocontent` iframe 中 polyfill API 为 function，且回答正文非空。
3. 加载节点 `aria-busy=false` 时，残留 `.ant-spin-dot` 的计算样式为 `display:none`。
4. 网络捕获无持续失败或长期 pending 的关键业务请求。
5. 多次间隔检查 DOM，确认正文常驻，没有 single-spa 重挂载循环；不依赖一次截图下结论。

这些补丁用于旧系统 WebView 的兼容验证，不等同于现代 Chrome。`structuredClone` 是 JSON 兜底，
`WeakRef/FinalizationRegistry` 仅防空引用崩溃，CSS 也只覆盖当前 antd 加载态问题。生产兼容性仍应在
较新 WebView 和真实设备上复核。
