#!/bin/bash

# Android APK 生成脚本
# 作者：灵光助手
# 包名：com.zrhq2013.app

echo "=========================================="
echo "      🚀 灵光 WebView APK 生成工具       "
echo "=========================================="
echo ""

# --- 配置区域 ---
PACKAGE_NAME="com.zrhq2013.app"
LAUNCH_URL="https://www.lingguang.com/share/CHAT-27eb3584-c60f-40ff-a042-ba5a820de81550?sharemedium=others"
APK_OUTPUT_DEBUG="app/build/outputs/apk/debug/app-debug.apk"
# ----------------

# 检查 gradle 是否可用
if ! command -v ./gradlew &> /dev/null; then
    echo "❌ 错误: 找不到 gradlew，请确保在 Android 项目根目录运行此脚本！"
    exit 1
fi

# 同步 H5 应用到 Android assets（排除 node_modules 与服务端依赖）
echo "📦 同步 webapp → app/src/main/assets/webapp ..."
SYNC_TARGET="app/src/main/assets/webapp"
rm -rf "$SYNC_TARGET"
mkdir -p "$SYNC_TARGET"
if command -v rsync &> /dev/null; then
  # 安全红线：.env 含签名私钥，严禁打入 APK assets
  rsync -a --exclude 'node_modules' --exclude 'package-lock.json' \
    --exclude '.env' --exclude '.env.*' --exclude '.env.local' \
    webapp/ "$SYNC_TARGET/"
else
  cp -R webapp/* "$SYNC_TARGET/"
  rm -rf "$SYNC_TARGET/node_modules" "$SYNC_TARGET/.env" "$SYNC_TARGET"/.env.*
fi
if [ -f "$SYNC_TARGET/.env" ]; then
  echo "❌ 安全拦截：$SYNC_TARGET/.env 不得存在于 APK 资源中"
  exit 1
fi
echo "✅ 同步完成"

# 清理旧文件
echo "🧹 正在清理旧构建文件..."
./gradlew clean > /dev/null 2>&1

echo ""
echo "🔨 开始编译 Debug APK (这可能需要 1-2 分钟)..."
./gradlew assembleDebug

# 检查是否成功
if [ -f "$APK_OUTPUT_DEBUG" ]; then
    echo ""
    echo "✅ ======================================"
    echo "   🎉 APK 编译成功！"
    echo "   📁 文件路径: $(pwd)/$APK_OUTPUT_DEBUG"
    echo "======================================="
    echo ""

    # 检查 ADB 和设备
    if ! command -v adb &> /dev/null; then
        echo "⚠️  未检测到 ADB 命令，请手动安装 APK"
        exit 0
    fi

    # 检查设备连接
    DEVICE_COUNT=$(adb devices | grep -w "device" | wc -l)
    if [ "$DEVICE_COUNT" -eq 0 ]; then
        echo "⚠️  未检测到已连接的手机，请插上手机后再试"
        exit 0
    fi

    echo "📱 检测到已连接的设备，准备自动安装..."
    echo ""

    # 安装 APK
    adb install -r "$APK_OUTPUT_DEBUG"
    
    if [ $? -eq 0 ]; then
        echo ""
        echo "🚀 正在启动应用..."
        # 启动 MainActivity
        adb shell am start -n "$PACKAGE_NAME/.MainActivity"
        echo ""
        echo "✅ 应用已成功安装并打开！"
    else
        echo ""
        echo "❌ 安装失败，可能设备未授权或签名冲突"
    fi
    
else
    echo ""
    echo "❌ APK 编译失败，请检查 Android Studio 中的报错信息"
    exit 1
fi
