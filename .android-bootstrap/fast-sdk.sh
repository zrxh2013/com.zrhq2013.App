#!/bin/bash
# 容器重置后快速重建 Android SDK（腾讯云镜像 + 手动解包，约 2 分钟）
# 用法: setsid bash /workspace/.android-bootstrap/fast-sdk.sh </dev/null >/dev/null 2>&1 &
MARK=/workspace/.android-bootstrap
BASE="https://mirrors.cloud.tencent.com/AndroidSDK"
SDK=/opt/android-sdk
ZIPDIR=/tmp/sdk-zips
LOG=$MARK/fast-sdk.log
stage(){ echo "STAGE:$1 $(date +%T)" > $MARK/fast-stage; }
fatal(){ echo "FATAL:$1 $(date +%T)" > $MARK/fast-stage; echo "FATAL:$1" >> $LOG; exit 1; }
exec >>$LOG 2>&1
echo "===== start $(date) ====="

export DEBIAN_FRONTEND=noninteractive
export JAVA_HOME=$(ls -d /root/.local/share/mise/installs/java/17*/ 2>/dev/null | head -1)
[ -z "$JAVA_HOME" ] && fatal no_jdk17
export ANDROID_HOME=$SDK ANDROID_SDK_ROOT=$SDK

stage deps
dpkg -s unzip libxcomposite1 libxtst6 libegl1 >/dev/null 2>&1 || apt-get update -qq
apt-get install -y --no-install-recommends unzip libgl1 libegl1 libgles2 libglx-mesa0 libglu1-mesa \
  libpulse0 libnss3 libxcomposite1 libxcursor1 libxi6 libxtst6 libxrandr2 \
  libdbus-1-3 libfontconfig1 libfreetype6 libxkbcommon0 libxkbfile1 libgbm1 \
  libx11-6 libxcb1 libx11-xcb1 libxdamage1 libxrender1 libxfixes3 libxext6 libsm6 \
  libglib2.0-0 || echo "WARN apt 部分包安装失败，继续" >> $LOG

stage cmdline
mkdir -p $SDK/cmdline-tools /tmp/sdk-zips
if [ ! -x $SDK/cmdline-tools/latest/bin/sdkmanager ]; then
  CT=/tmp/sdk-zips/commandlinetools-linux-11076708_latest.zip
  [ -f "$CT" ] || curl -fL --retry 5 -o "$CT" "$BASE/commandlinetools-linux-11076708_latest.zip" || fatal dl_cmdline
  rm -rf /tmp/sdk-stage/ct; mkdir -p /tmp/sdk-stage/ct
  unzip -q "$CT" -d /tmp/sdk-stage/ct || fatal unzip_cmdline
  rm -rf $SDK/cmdline-tools/latest
  mv /tmp/sdk-stage/ct/cmdline-tools $SDK/cmdline-tools/latest || fatal mv_cmdline
fi

stage sdk_install
# 关键：SDK_TEST_BASE_URL 必须带结尾斜杠，否则 sdkmanager 判为非法并回退到慢速 dl.google.com
export SDK_TEST_BASE_URL="$BASE/"
SDKM=$SDK/cmdline-tools/latest/bin/sdkmanager
PX="--proxy=http --proxy_host=127.0.0.1 --proxy_port=18080"
yes | $SDKM $PX --licenses >/dev/null 2>&1
yes | $SDKM $PX "platform-tools" "platforms;android-34" "build-tools;34.0.0" \
  "emulator" "system-images;android-30;default;x86_64" || fatal sdk_install
$SDKM --list_installed 2>/dev/null | grep -E 'platform-tools|build-tools;34|platforms;android-34|emulator|system-images;android-30' || fatal verify

stage links
mkdir -p $SDK/platforms $SDK/build-tools 2>/dev/null
[ -d $SDK/platforms/android-34 ] || ln -sfn $SDK/platforms/android-34-ext12 $SDK/platforms/android-34 2>/dev/null
[ -d $SDK/build-tools/34.0.0 ] || ln -sfn $SDK/build-tools/34.0.0 $SDK/build-tools/34.0.0 2>/dev/null
cat > /etc/profile.d/android-sdk.sh <<'EOF'
export ANDROID_HOME=/opt/android-sdk
export ANDROID_SDK_ROOT=/opt/android-sdk
export PATH="$PATH:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/emulator"
EOF
for t in platform-tools/adb platform-tools/fastboot cmdline-tools/latest/bin/sdkmanager \
         cmdline-tools/latest/bin/avdmanager emulator/emulator; do
  ln -sf $SDK/$t /usr/local/bin/$(basename $t)
done
echo ANDROID_HOME=/opt/android-sdk >> /etc/environment

stage avd
export PATH=$PATH:$SDK/cmdline-tools/latest/bin:$SDK/platform-tools
if [ ! -f /root/.android/avd/aosp30.avd/config.ini ]; then
  echo "no" | avdmanager create avd -n aosp30 -k "system-images;android-30;default;x86_64" --force || fatal avd_create
fi
CFG=/root/.android/avd/aosp30.avd/config.ini
sed -i -E '/^hw\.ramSize=/d; /^vm\.heapSize=/d; /^hw\.lcd\.(width|height|density)=/d; /^hw\.cpu\.ncore=/d; /^hw\.lcd\.vsync=/d' $CFG
cat >> $CFG <<'EOF'
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
EOF
rm -f /root/.android/avd/aosp30.avd/hardware-qemu.ini*

stage sdk_done
echo "sdk ready $(date)" >> $LOG
