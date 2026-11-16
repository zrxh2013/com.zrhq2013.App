#!/bin/bash
# 等待模拟器启动完成后做最小化 provision（网络代理、跳过向导、关闭动画/校验）
MARK=/workspace/.android-bootstrap
LOG=$MARK/boot.log
stage(){ echo "STAGE:$1 $(date +%T)" > $MARK/fast-stage; }
fatal(){ echo "FATAL:$1 $(date +%T)" > $MARK/fast-stage; echo "FATAL:$1" >> $LOG; exit 1; }
exec >>$LOG 2>&1
export PATH=$PATH:/opt/android-sdk/platform-tools

stage boot
adb wait-for-device || fatal adb_wait
BOOT=""
for i in $(seq 1 40); do
  B=$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')
  echo "boot_poll[$i] boot=${B:-空} $(date +%T)"
  [ "$B" = 1 ] && { BOOT=1; break; }
  pgrep -f qemu-system >/dev/null || fatal emulator_gone
  sleep 15
done
[ "$BOOT" = 1 ] || fatal boot_timeout

stage service_wait
for i in $(seq 1 30); do
  S=$(adb shell service check package 2>/dev/null | tr -d '\r')
  echo "pkg_service[$i] $S"
  case "$S" in *"package:"*) break;; esac
  sleep 5
done

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
adb shell settings put global window_animation_scale 0
adb shell settings put global transition_animation_scale 0
adb shell settings put global animator_duration_scale 0
adb shell settings put global verifier_verify_adb_installs 0
adb shell input keyevent KEYCODE_HOME
stage ready
echo "ready $(date +%T)" >> $LOG
