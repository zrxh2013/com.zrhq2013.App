#!/bin/bash

# Android APK 生成脚本
# 用于快速生成和安装 APK 文件

echo "=========================================="
echo "Android APK 生成工具"
echo "=========================================="
echo ""

# 检查 gradle 是否可用
if ! command -v ./gradlew &> /dev/null; then
    echo "❌ 错误: gradlew 不可用"
    exit 1
fi

echo "📦 开始清理和编译项目..."
echo ""

# 清理旧的构建文件
./gradlew clean

# 编译 debug APK
echo ""
echo "🔨 编译 Debug APK..."
./gradlew assembleDebug

# 检查是否成功
if [ -f "app/build/outputs/apk/debug/app-debug.apk" ]; then
    echo ""
    echo "✅ Debug APK 生成成功！"
    echo "📁 文件位置: $(pwd)/app/build/outputs/apk/debug/app-debug.apk"
    echo ""
    
    # 检查 ADB 是否可用
    if command -v adb &> /dev/null; then
        echo "📱 检查连接的设备..."
        adb devices
        
        echo ""
        read -p "是否要立即安装到设备? (y/n) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            echo "📥 正在安装 APK..."
            adb install -r app/build/outputs/apk/debug/app-debug.apk
            
            echo ""
            echo "🚀 启动应用..."
            adb shell am start -n com.zrhq2013.app/.MainActivity
            
            echo ""
            echo "✅ 应用已启动！"
        fi
    else
        echo "⚠️  ADB 不可用，请手动安装 APK"
    fi
else
    echo ""
    echo "❌ APK 生成失败，请检查错误信息"
    exit 1
fi

echo ""
echo "=========================================="
