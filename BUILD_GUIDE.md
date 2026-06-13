# 🚀 一键生成和安装 APK 指南

## 快速开始

### Windows 用户

```bash
# 方式 1: 双击运行
build.bat

# 方式 2: 在命令行运行
cd 项目根目录
build.bat
```

### macOS / Linux 用户

```bash
# 1. 赋予执行权限（首次需要）
chmod +x build.sh

# 2. 运行脚本
./build.sh
```

---

## 脚本功能

✅ **自动编译** - 编译 Debug APK
✅ **自动安装** - 安装到已连接的 Android 设备
✅ **自动启动** - 编译和安装成功后自动打开应用
✅ **错误检测** - 自动检测常见问题

---

## 前置条件

### 1. 配置 Android 开发环境

必需：
- ✅ Android SDK (API 24+)
- ✅ Android Build Tools
- ✅ JDK 11 或更高版本

### 2. 连接 Android 设备

**USB 连接：**
1. 用 USB 数据线连接手机
2. 在手机上开启 USB 调试
3. 在 PC 上允许连接

**启用 USB 调试方法：**

不同型号手机步骤可能有差异，大致流程：

1. 打开设置
2. 关于手机 → 连续点击版本号 7 次
3. 返回设置 → 开发者选项
4. 启用 USB 调试

---

## 使用流程

### 第一次使用

```bash
# 1. 打开项目根目录
cd 你的项目路径/com.zrhq2013.App

# 2. 连接手机（USB 调试已启用）

# 3. 运行构建脚本
./build.sh          # macOS/Linux
build.bat           # Windows

# 脚本会自动:
# ✅ 清理旧文件
# ✅ 编译 APK
# ✅ 安装到设备
# ✅ 启动应用
```

### 后续使用

每次需要生成新 APK 时，直接运行脚本即可。

---

## 常见问题

### Q1: "找不到 gradlew"

**原因**: 不在项目根目录

**解决**:
```bash
cd 到项目根目录
# 应该能看到 gradlew 和 gradlew.bat 文件
ls -la gradlew*
```

### Q2: "未检测到 ADB 命令"

**原因**: Android SDK 未正确安装或环境变量未配置

**解决**:

**Windows:**
1. 打开环境变量设置
2. 在 Path 中添加: `C:\Users\用户名\AppData\Local\Android\Sdk\platform-tools`
3. 重启命令行

**macOS:**
```bash
echo 'export PATH="$PATH:$HOME/Library/Android/sdk/platform-tools"' >> ~/.zshrc
source ~/.zshrc
```

**Linux:**
```bash
echo 'export PATH="$PATH:$HOME/Android/Sdk/platform-tools"' >> ~/.bashrc
source ~/.bashrc
```

### Q3: "未检测到已连接的设备"

**原因**: 手机未连接或 USB 调试未启用

**解决**:
1. 检查 USB 数据线是否正常连接
2. 查看手机通知栏，同意 USB 调试权限
3. 运行 `adb devices` 检查

### Q4: "安装失败，签名冲突"

**原因**: 手机上已安装的 APK 与新 APK 签名不同

**解决**:
```bash
# 先卸载旧版本
adb uninstall com.zrhq2013.app

# 再运行脚本
./build.sh  # 或 build.bat
```

### Q5: "APK 编译失败"

**原因**: 代码错误或依赖问题

**解决**:
1. 检查 Android Studio 中的错误信息
2. 尝试手动运行: `./gradlew clean assembleDebug`
3. 查看完整日志信息

---

## 手动安装 APK（脚本失败时）

### 方式 1: Android Studio

1. 在 Android Studio 中打开项目
2. 点击 **Build → Select Build Variant**
3. 选择 **debug**
4. 点击 **Run → Run 'app'** (Shift + F10)

### 方式 2: 命令行

```bash
# 编译 APK
./gradlew assembleDebug

# 安装到设备
adb install -r app/build/outputs/apk/debug/app-debug.apk

# 启动应用
adb shell am start -n com.zrhq2013.app/.MainActivity
```

### 方式 3: 直接拖拽（需要文件管理器）

1. 找到 APK 文件: `app/build/outputs/apk/debug/app-debug.apk`
2. 将 APK 复制到手机存储
3. 用文件管理器打开并安装

---

## 验证安装成功

```bash
# 查看已安装的包
adb shell pm list packages | grep zrhq2013

# 查看应用详细信息
adb shell dumpsys package com.zrhq2013.app

# 查看实时日志
adb logcat | grep zrhq2013
```

---

## 应用开启后

✅ 应用会自动加载: https://www.lingguang.com/share/CHAT-27eb3584-c60f-40ff-a042-ba5a820de81550

✅ 支持所有 WebView 功能:
- JavaScript 支持
- 文件上传/下载
- 媒体播放
- 地理定位
- 摄像头访问
- 等等

---

## 技术信息

| 项目 | 值 |
|------|-----|
| 应用名 | 闪应用 |
| 包名 | com.zrhq2013.app |
| 最小 SDK | 24 (Android 7.0) |
| 目标 SDK | 34 (Android 14) |
| 构建工具 | Gradle 8.1 |
| 编译目标 | Debug APK |
| 签名 | Debug 自签名 |

---

## 支持

如遇问题，请查看:
- README.md - 项目完整说明
- 错误日志中的详细信息
- Android Studio 中的构建输出

---

**祝你编译顺利！🎉**
