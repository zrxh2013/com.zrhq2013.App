#!/bin/bash
# 受限容器（无 KVM / 4GB cgroup）Android SDK + AVD + 无头模拟器一键自举
# 存放在持久化 /workspace，容器重置后可直接重跑：setsid bash 本脚本
MARK=/workspace/.android-bootstrap
mkdir -p $MARK
exec >$MARK/setup.log 2>&1
stage(){ echo "STAGE:$1 $(date +%T)" > $MARK/stage; }
fatal(){ echo "FATAL:$1 $(date +%T)" > $MARK/stage; exit 1; }

stage apt
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq || fatal apt_update
apt-get install -y --no-install-recommends \
  libgl1 libegl1 libgles2 libglx-mesa0 libglu1-mesa \
  libpulse0 libpulse-mainloop-glib0 libnss3 libxcomposite1 libxcursor1 libxi6 libxtst6 \
  libxrandr2 libasound2t64 libdbus-1-3 libfontconfig1 libfreetype6 \
  libxkbcommon0 libxkbfile1 libcurl4t64 libgbm1 libx11-6 libxcb1 libx11-xcb1 \
  libxdamage1 libxrender1 libxfixes3 libxext6 libsm6 libglib2.0-0t64 unzip || fatal apt_install

stage cmdline
mkdir -p /opt/android-sdk/cmdline-tools
curl -sSL --retry 3 -o /tmp/cmdline-tools.zip \
  "https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip" || fatal dl_cmdline
rm -rf /tmp/ct && mkdir -p /tmp/ct && unzip -q /tmp/cmdline-tools.zip -d /tmp/ct
rm -rf /opt/android-sdk/cmdline-tools/latest
mv /tmp/ct/cmdline-tools /opt/android-sdk/cmdline-tools/latest

export JAVA_HOME=$(ls -d /root/.local/share/mise/installs/java/17*/ 2>/dev/null | head -1)
[ -z "$JAVA_HOME" ] && fatal no_jdk17
export ANDROID_HOME=/opt/android-sdk
export ANDROID_SDK_ROOT=/opt/android-sdk
SDKM=/opt/android-sdk/cmdline-tools/latest/bin/sdkmanager

stage sdk_licenses
yes | $SDKM --licenses || fatal licenses
stage sdk_packages
yes | $SDKM "platform-tools" "platforms;android-34" "build-tools;34.0.0" \
  "emulator" "system-images;android-30;default;x86_64" || fatal sdk_packages

stage env_links
cat > /etc/profile.d/android-sdk.sh <<'EOF'
export ANDROID_HOME=/opt/android-sdk
export ANDROID_SDK_ROOT=/opt/android-sdk
export PATH="$PATH:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/emulator"
EOF
grep -q 'profile.d/android-sdk.sh' ~/.bashrc 2>/dev/null || echo 'source /etc/profile.d/android-sdk.sh' >> ~/.bashrc
grep -q ANDROID_HOME /etc/environment 2>/dev/null || printf 'ANDROID_HOME=/opt/android-sdk\nANDROID_SDK_ROOT=/opt/android-sdk\n' >> /etc/environment
for t in platform-tools/adb platform-tools/fastboot cmdline-tools/latest/bin/sdkmanager \
         cmdline-tools/latest/bin/avdmanager emulator/emulator; do
  ln -sf /opt/android-sdk/$t /usr/local/bin/$(basename $t)
done

stage avd
echo "no" | avdmanager create avd -n aosp30 -k "system-images;android-30;default;x86_64" --force || fatal avd_create
CFG=/root/.android/avd/aosp30.avd/config.ini
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

stage emulator_launch
nohup /opt/android-sdk/emulator/emulator -avd aosp30 \
  -no-window -no-audio -no-boot-anim -no-snapshot \
  -no-accel -netdelay none -netspeed full -no-metrics \
  > /tmp/emulator.log 2>&1 &
EMU_PID=$!

stage boot
export PATH=$PATH:/opt/android-sdk/platform-tools
adb wait-for-device
BOOT=""
for i in $(seq 1 24); do
  B=$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')
  A=$(awk '/^anon /{printf "%.0f",$2/1024/1024}' /sys/fs/cgroup/memory.stat 2>/dev/null)
  echo "boot_poll[$i] boot=${B:-空} anon=${A}MB"
  [ "$B" = 1 ] && { BOOT=1; break; }
  kill -0 $EMU_PID 2>/dev/null || fatal emulator_gone
  sleep 25
done
[ "$BOOT" = 1 ] || fatal boot_timeout

stage provision
adb shell input keyevent KEYCODE_WAKEUP
adb shell wm dismiss-keyguard
adb shell svc power stayon true
adb shell settings put system screen_off_timeout 600000
adb shell settings put global device_provisioned 1
adb shell settings put secure user_setup_complete 1
adb shell am force-stop com.android.managedprovisioning 2>/dev/null
adb shell svc bluetooth disable 2>/dev/null
adb shell settings put global http_proxy 10.0.2.2:18080
adb shell input keyevent KEYCODE_HOME
# 等待 TCG 负载回落并处理 SystemUI 假死 ANR（点 Wait）
sleep 75
adb shell input tap 183 565
sleep 20
adb shell input keyevent KEYCODE_HOME
sleep 25
adb shell input tap 183 565 2>/dev/null
sleep 10
adb exec-out screencap -p > /workspace/emulator-home.png 2>/dev/null
adb shell dumpsys window 2>/dev/null | grep mCurrentFocus >> $MARK/setup.log
adb devices >> $MARK/setup.log 2>&1

stage done
