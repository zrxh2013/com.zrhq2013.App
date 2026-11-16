#!/bin/bash
# 无 KVM 容器内以 TCG 软件模拟启动 AVD（单核，稳定）
export ANDROID_HOME=/opt/android-sdk
export ANDROID_SDK_ROOT=/opt/android-sdk
export ANDROID_I_WANT_MY_TCG=yes
export LD_LIBRARY_PATH=/opt/android-sdk/emulator/lib64:$LD_LIBRARY_PATH
exec /opt/android-sdk/emulator/emulator -avd aosp30 \
  -no-window -no-audio -no-boot-anim -no-snapshot \
  -accel off -netdelay none -netspeed full -no-metrics
