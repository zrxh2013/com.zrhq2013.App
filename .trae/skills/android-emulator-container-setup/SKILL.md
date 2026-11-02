---
name: "android-emulator-container-setup"
description: "Bootstrap Android SDK/adb and a headless emulator in KVM-less, 4GB cgroup-limited Linux containers. Invoke when container was reset or user asks to install SDK/adb/emulator/AVD and launch an Android emulator."
---

# 受限容器内 Android SDK + 无头模拟器搭建

在**无 KVM 硬件加速、内存 cgroup 上限 4GB、无显示器（DISPLAY 未设）、可能随时重置**的远程 Linux
容器（Ubuntu 24.04）中，从零安装 Android SDK、adb，创建 AVD 并以纯软件模拟方式无头启动模拟器。

## 何时使用

- 用户要求安装 Android SDK / adb / emulator / 创建 AVD / 启动模拟器
- 容器疑似重置后（`/opt/android-sdk` 或 AVD 丢失）需要恢复 Android 构建/运行环境
- 需要用 `adb` 向模拟器安装 APK 验证

## 环境基线（先用真实命令核实，不要假设）

```bash
uname -m                                    # 期望 x86_64
ls -l /dev/kvm 2>&1                         # 预期“不存在”→ 必须 -no-accel
cat /sys/fs/cgroup/memory.max 2>/dev/null   # 本工作区为 4294967296（4GB，硬上限）
ls /opt/android-sdk 2>&1                    # 判断是否已装/容器是否重置
ls -d /root/.local/share/mise/installs/java/17.0.2  # JDK17 是否还在
echo "$https_proxy"                         # 本工作区为 http://127.0.0.1:18080
curl -s -o /dev/null -w '%{http_code}\n' --max-time 12 https://dl.google.com/android/repository/repository2-3.xml
```

关键事实（已实测）：
- 容器重置后 `/opt/android-sdk`、`~/.android/avd`、apt 安装的系统库、`/usr/local/bin` 软链接全部丢失；
  mise 管理的 JDK 通常保留。
- sdkmanager 必须用 **JDK 17**（默认 JDK 25 可能异常）：
  `export JAVA_HOME=/root/.local/share/mise/installs/java/17.0.2`

## 第 1 步：安装系统原生库 + 下载 cmdline-tools（可并行）

精简 Ubuntu 缺 libGL/pulse/nss 等，不装 emulator 无法运行（报 `libxkbfile.so.1 cannot open`）：

```bash
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  libgl1 libegl1 libgles2 libglx-mesa0 libglu1-mesa \
  libpulse0 libpulse-mainloop-glib0 libnss3 libxcomposite1 libxcursor1 libxi6 libxtst6 \
  libxrandr2 libasound2t64 libdbus-1-3 libfontconfig1 libfreetype6 \
  libxkbcommon0 libxkbfile1 libcurl4t64 libgbm1 libx11-6 libxcb1 libx11-xcb1 \
  libxdamage1 libxrender1 libxfixes3 libxext6 libsm6 libglib2.0-0t64 unzip
```

```bash
mkdir -p /opt/android-sdk/cmdline-tools
curl -sSL --retry 3 -o /tmp/cmdline-tools.zip \
  "https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"
rm -rf /tmp/ct && mkdir -p /tmp/ct && unzip -q /tmp/cmdline-tools.zip -d /tmp/ct
rm -rf /opt/android-sdk/cmdline-tools/latest
mv /tmp/ct/cmdline-tools /opt/android-sdk/cmdline-tools/latest
```

## 第 2 步：接受许可并安装 SDK 组件

```bash
export JAVA_HOME=/root/.local/share/mise/installs/java/17.0.2
export ANDROID_HOME=/opt/android-sdk ANDROID_SDK_ROOT=/opt/android-sdk
SDKM=$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager
yes | $SDKM --licenses
yes | $SDKM "platform-tools" "platforms;android-34" "build-tools;34.0.0" "emulator" \
  "system-images;android-30;default;x86_64"
# API34 镜像仅在需要时再装（见“内存红线”）：
# yes | $SDKM "system-images;android-34;default;x86_64"
$SDKM --list_installed   # 验证
```

## 第 3 步：环境变量 + 全局软链接（非交互 shell 必需）

profile.d 只对登录/交互 shell 生效；Gradle/脚本子进程拿不到。除 profile 外必须建软链接：

```bash
cat > /etc/profile.d/android-sdk.sh <<'EOF'
export ANDROID_HOME=/opt/android-sdk
export ANDROID_SDK_ROOT=/opt/android-sdk
export PATH="$PATH:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/emulator"
EOF
grep -q 'profile.d/android-sdk.sh' ~/.bashrc || echo 'source /etc/profile.d/android-sdk.sh' >> ~/.bashrc
grep -q ANDROID_HOME /etc/environment || printf 'ANDROID_HOME=/opt/android-sdk\nANDROID_SDK_ROOT=/opt/android-sdk\n' >> /etc/environment
for t in platform-tools/adb platform-tools/fastboot cmdline-tools/latest/bin/sdkmanager \
         cmdline-tools/latest/bin/avdmanager emulator/emulator; do
  ln -sf /opt/android-sdk/$t /usr/local/bin/$(basename $t)
done
# 最严格验证：env -i 清空变量后仍可用
env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin adb version
```

## 第 4 步：创建 AVD（用 API 30 default 镜像）

**内存红线（本工作区最大的坑）**：emulator 37 会强制上调 guest RAM：
- 任何 **API 34** 镜像（default 与 google_apis 一样）→ 日志 `Increasing RAM size to 2560MB`，
  4GB cgroup 下运行期 anon 增长到 ~3.9GB 必被 OOM Kill（dmesg 可见
  `Memory cgroup out of memory: Killed process ... (qemu-system-x86)`）。
- **API 30 default x86_64** → 下限 2048MB，运行期 anon 稳定在 ~3.2GB，余量 ~800MB，可长期存活。
- WebView 类 App（minSdk 24）在 API 30 模拟器上安装运行完全没问题；编译仍用 platforms;android-34。

```bash
export JAVA_HOME=/root/.local/share/mise/installs/java/17.0.2
echo "no" | avdmanager create avd -n aosp30 \
  -k "system-images;android-30;default;x86_64" --force
CFG=/root/.android/avd/aosp30.avd/config.ini
# 删掉模板默认的同名单行键（无空格的 key=value），避免重复
sed -i -E '/^hw\.ramSize=/d; /^vm\.heapSize=/d; /^hw\.lcd\.(width|height|density)=/d; /^hw\.cpu\.ncore=/d' $CFG
cat >> $CFG <<'EOF'
hw.ramSize = 1536
vm.heapSize = 192
hw.cpu.ncore = 2
hw.lcd.width = 540
hw.lcd.height = 960
hw.lcd.density = 240
hw.bluetoothSupport = no
hw.gpu.enabled = yes
hw.gpu.mode = auto
disk.dataPartition.size = 4096M
EOF
rm -f /root/.android/avd/aosp30.avd/hardware-qemu.ini*
emulator -list-avds   # 应列出 aosp30
```

注意：config.ini 的格式是 `key = value`（等号两侧有空格）；emulator 启动时会重新生成
`hardware-qemu.ini` 并按镜像下限校正 RAM（1536→2048 正常，不是配置没生效）。

## 第 5 步：无头启动（纯软件模拟）

```bash
nohup emulator -avd aosp30 \
  -no-window -no-audio -no-boot-anim -no-snapshot \
  -no-accel -netdelay none -netspeed full -no-metrics \
  > /tmp/emulator.log 2>&1 &
```

- 无 KVM 必须 `-no-accel`；GPU 让其 auto 选择软件后端（API30 实测选 swangle/lavapipe，可截图）。
  若用 API34/google 镜像需显式 `-gpu swiftshader`（旧别名 `swiftshader_indirect` 可能截到纯黑屏）。
- 冷启动约 5 分钟（全新 AVD 含 dexopt 约 5 分钟；API34 首次约 10–13 分钟）。
- 启动后轮询：

```bash
for i in $(seq 1 22); do
  sleep 30
  B=$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')
  A=$(awk '/^anon /{printf "%.0f",$2/1024/1024}' /sys/fs/cgroup/memory.stat)
  echo "[$((i*30))s] boot=${B:-<空>} anon=${A}MB"
  [ "$B" = 1 ] && { echo BOOT_OK; break; }
  pgrep -x qemu-system-x86 >/dev/null || { echo PROCESS_GONE; tail -8 /tmp/emulator.log; break; }
done
```

内存判断要点：cgroup `memory.current` 里 file cache（约 0.9GB）是**可回收**的，接近 4GB 不必慌；
真正硬指标是 `memory.stat` 的 **anon**，稳定在 <3.4GB 即安全。无 reclaim 权限时写
`memory.reclaim` 会报只读，忽略即可。

## 第 6 步：开机后的处理（TCG 很慢，SystemUI 易 ANR）

```bash
adb shell input keyevent KEYCODE_WAKEUP
adb shell wm dismiss-keyguard
adb shell svc power stayon true
adb shell settings put system screen_off_timeout 600000
# 跳过引导/向导
adb shell settings put global device_provisioned 1
adb shell settings put secure user_setup_complete 1
adb shell am force-stop com.android.managedprovisioning 2>/dev/null
# API34 google 镜像还需：adb shell pm disable-user --user 0 com.google.android.googlesdksetup
# 蓝牙栈在 TCG 下会反复 SIGABRT，关掉：adb shell svc bluetooth disable
adb shell input keyevent KEYCODE_HOME
```

- 出现 “System UI isn't responding” 时**点 Wait，不要 Close**（软件模拟下是假死，负载回落后恢复）。
  540x960 下 Wait 按钮坐标约 (183,565)：`adb shell input tap 183 565`。
- boot 后早期截图可能 4–16KB 纯黑且 `mCurrentFocus=null`，是负载极高（load 20+）导致帧未产出；
  等 2–5 分钟负载回落后再截，正常桌面 PNG 约 150–700KB。
- 验证：`adb exec-out screencap -p > /workspace/emulator-home.png`、
  `adb shell dumpsys window | grep mCurrentFocus`（应为 launcher3）。

## 常用命令

```bash
adb devices                                  # emulator-5554 device
adb emu kill                                 # 优雅关闭（首选）
# 切勿用 pkill -f qemu-system...：模式会匹配到执行命令的 shell 自身把自己杀掉；
# 需要强杀时用：kill $(pgrep -x qemu-system-x86)
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.zrhq2013.app/.MainActivity
```

## 故障速查

| 现象 | 原因 | 处理 |
|---|---|---|
| qemu 启动后几分钟消失，dmesg 有 cgroup OOM | guest RAM 上限过高（API34=2560MB） | 换 aosp30（API30）AVD；勿再加大 RAM |
| `emulator: error while loading libxkbfile.so.1` | 缺系统库 | 执行第 1 步 apt 安装 |
| `sdkmanager` 运行异常 | 默认 JDK 25 | `export JAVA_HOME=.../java/17.0.2` |
| 非交互 shell 里 `adb: command not found` | profile.d 不生效 | 用 /usr/local/bin 软链接（第 3 步） |
| 截图纯黑、焦点 null | TCG 高负载渲染滞后 | 等待负载回落、点 Wait、回 Home 后重截 |
| 蓝牙进程反复 Fatal signal 6 | TCG 不兼容 | `svc bluetooth disable`、AVD 设 `hw.bluetoothSupport = no` |
| 容器又重置了 | /opt、apt、软链接均易失，mise JDK 保留 | 从第 1 步完整重跑；dexopt 成果在 ~/.android，重置后也需重建 |
