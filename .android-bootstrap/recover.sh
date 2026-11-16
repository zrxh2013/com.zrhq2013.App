#!/bin/bash
# 容器整体重置后的一键恢复：SDK -> 模拟器 -> provision -> 安装 -> 启动
# setsid bash /workspace/.android-bootstrap/recover.sh </dev/null >/dev/null 2>&1 &
MARK=/workspace/.android-bootstrap
export PATH=$PATH:/opt/android-sdk/platform-tools
stage(){ echo "STAGE:$1 $(date +%T)" > $MARK/fast-stage; }

bash $MARK/fast-sdk.sh || exit 1
grep -q STAGE:sdk_done $MARK/fast-stage || { echo "FATAL:sdk $(date +%T)" > $MARK/fast-stage; exit 1; }

stage emulator_launch
setsid bash $MARK/run-emulator.sh </dev/null >/tmp/emulator.log 2>&1 &
sleep 5
bash $MARK/boot-wait.sh || exit 1
grep -q STAGE:ready $MARK/fast-stage || exit 1

stage install
for i in $(seq 1 20); do
  R=$(timeout 180 adb install -r /workspace/app/build/outputs/apk/debug/app-debug.apk 2>&1 | tail -1)
  echo "$i $R" >> $MARK/recover.log
  case "$R" in *Success*) break;; esac
  sleep 15
done

stage app_start
adb shell am force-stop com.zrhq2013.app
adb shell am start -n com.zrhq2013.app/.MainActivity >> $MARK/recover.log 2>&1
sleep 20
PID=$(adb shell pidof com.zrhq2013.app | tr -d '\r')
[ -n "$PID" ] && adb forward tcp:9333 localabstract:webview_devtools_remote_$PID
stage app_started
echo "app_started pid=$PID $(date +%T)" >> $MARK/recover.log
