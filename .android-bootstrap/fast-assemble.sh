#!/bin/bash
# 高速方案：从腾讯云镜像下载 SDK 包，按 package.xml 的 path 还原目录布局
# 解决 dl.google.com 经共享代理被限速到 ~30KB/s 的问题（镜像 2MB/s+）
MARK=/workspace/.android-bootstrap
ZIPDIR=/tmp/sdk-zips
BASE="https://mirrors.cloud.tencent.com/AndroidSDK"
SDK=/opt/android-sdk
stage(){ echo "STAGE:$1 $(date +%T)" > $MARK/fast-stage; }
fatal(){ echo "FATAL:$1 $(date +%T)" > $MARK/fast-stage; exit 1; }
exec >$MARK/fast-assemble.log 2>&1

# 包名|相对路径|期望字节数
PKGS="
platform-tools_r37.0.3-linux.zip|platform-tools_r37.0.3-linux.zip|9571024
build-tools_r34-linux.zip|build-tools_r34-linux.zip|61224257
emulator-linux_x64-16863232.zip|emulator-linux_x64-16863232.zip|350070672
platform-34-ext12_r01.zip|platform-34-ext12_r01.zip|63559957
x86_64-30_r11.zip|sys-img/android/x86_64-30_r11.zip|676379777
"

stage download
mkdir -p $ZIPDIR
echo "$PKGS" | while IFS='|' read name rel size; do
  [ -z "$name" ] && continue
  out=$ZIPDIR/$name
  if [ -f "$out" ] && [ "$(stat -c %s "$out")" = "$size" ]; then
    echo "已存在且完整: $name"; continue
  fi
  echo "下载 $name (期望 $size 字节) <- $BASE/$rel"
  curl -fL --retry 5 --retry-delay 3 -C - -o "$out" "$BASE/$rel" || fatal "dl_$name"
  got=$(stat -c %s "$out")
  [ "$got" = "$size" ] || fatal "size_$name got=$got want=$size"
  echo "完成 $name ($got 字节)"
done

stage extract
STAGE=/tmp/sdk-stage
rm -rf $STAGE; mkdir -p $STAGE
for z in $ZIPDIR/*.zip; do
  n=$(basename $z)
  d=$STAGE/${n%.zip}
  mkdir -p "$d"
  unzip -q "$z" -d "$d" || fatal "unzip_$n"
  # 定位含 package.xml 的顶层包目录
  pxml=$(find "$d" -maxdepth 2 -name package.xml | head -1)
  [ -z "$pxml" ] && fatal "no_pkgxml_$n"
  pkgdir=$(dirname "$pxml")
  # 读取 path 字段，如 system-images;android-30;default;x86_64
  ppath=$(grep -oE 'path="[^"]+"' "$pxml" | head -1 | sed 's/path="//;s/"//')
  [ -z "$ppath" ] && fatal "no_path_$n"
  reltgt=$(echo "$ppath" | tr ';' '/')
  tgt=$SDK/$reltgt
  echo "[$n] path=$ppath -> $tgt"
  mkdir -p "$(dirname "$tgt")"
  rm -rf "$tgt"
  mv "$pkgdir" "$tgt"
  [ -f "$tgt/package.xml" ] || fatal "postmove_$n"
done

stage verify
export JAVA_HOME=$(ls -d /root/.local/share/mise/installs/java/17*/ 2>/dev/null | head -1)
export ANDROID_HOME=$SDK ANDROID_SDK_ROOT=$SDK
$SDK/cmdline-tools/latest/bin/sdkmanager --list_installed 2>&1 | grep -E 'platform-tools|build-tools;34|platforms;android-34|emulator|system-images;android-30' || fatal verify
stage assemble_done
