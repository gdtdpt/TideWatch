#!/usr/bin/env bash
#
# 拉取 ffmpeg / ffprobe 静态构建到 vendor/ffmpeg/bin/。
#
# 为什么不用 brew / npm：
#   - 目标机不一定有 brew；
#   - ffmpeg 不是 Node 包，`ffmpeg-static` 之类靠 postinstall 下二进制，
#     pnpm 12 要 allowBuilds 白名单，离线机器和国内网络都容易卡。
#
# 为什么放 vendor/ 而不是塞进 PATH：
#   service.ts 的解析链是 TIDEWATCH_FFMPEG > vendor/ffmpeg/bin > PATH，
#   放 vendor/ 等于提前跑通分发目录布局（docs/02 §7 的层 B：平台相关件）。
#
# 来源：
#   主源 ffmpeg.martin-riedl.de（macOS/Linux × amd64/arm64）
#   备源 evermeet.cx（仅 macOS amd64，主源失败时回退）
#
# 用法：
#   tools/fetch-ffmpeg.sh                          # 装最新版
#   tools/fetch-ffmpeg.sh --only ffprobe           # 只补一个
#   tools/fetch-ffmpeg.sh --force                  # 已存在也重下
#   tools/fetch-ffmpeg.sh --expect-version 9.0.2   # 下完校验版本，不符即失败
#
# 装完的版本记在 vendor/ffmpeg/VERSION（打包时随包，不入库）。

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DEST="$ROOT/vendor/ffmpeg/bin"
VERSION_FILE="$ROOT/vendor/ffmpeg/VERSION"
RIEDL="https://ffmpeg.martin-riedl.de/redirect/latest"
EVERMEET="https://evermeet.cx/ffmpeg"
EXPECT=""
FORCE=0
ONLY="ffmpeg ffprobe"
VERSIONS=""

usage() {
  sed -n '3,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY="${2:-}"; shift 2 ;;
    --expect-version) EXPECT="${2:-}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "未知参数：$1" >&2; usage; exit 2 ;;
  esac
done

case "$(uname -s)" in
  Darwin) PLATFORM=macos ;;
  Linux) PLATFORM=linux ;;
  *)
    echo "不支持的平台：$(uname -s)（Windows 请用 gyan.dev / BtbN 静态包）" >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) ARCH=amd64 ;;
  arm64 | aarch64) ARCH=arm64 ;;
  *)
    echo "不支持的架构：$(uname -m)" >&2
    exit 1
    ;;
esac

# 备源只有 macOS amd64；其他组合没有备源
if [ "$PLATFORM" = "macos" ] && [ "$ARCH" = "amd64" ]; then
  HAS_FALLBACK=1
else
  HAS_FALLBACK=0
fi

# 从 evermeet 的发布 JSON 取字段（备源用）
meta() {
  local name="$1" field="$2"
  FIELD="$field" INFO_URL="$EVERMEET/info/$name/release" node -e '
    const url = process.env.INFO_URL;
    const field = process.env.FIELD;
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`info HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => {
        const v = field === "version" ? d.version : d.download?.zip?.url;
        if (!v) throw new Error(`发布信息里没有 ${field}`);
        console.log(v);
      })
      .catch((e) => {
        console.error(`取 ${url} 失败：${e.message}`);
        process.exit(1);
      });
  '
}

version_of() {
  # 第三方构建会把自家站点拼进版本号（9.0.2-https://...），切掉尾巴只留版本
  "$1" -version 2>&1 | head -1 |
    sed -nE 's/.*(ffmpeg|ffprobe) version ([^ ]+).*/\2/p' |
    sed -E 's/-https?:\/\/.*$//'
}

fetch_one() {
  local name="$1" target url source zip version tmpdir found v
  target="$DEST/$name"

  if [ -f "$target" ] && [ "$FORCE" -eq 0 ]; then
    echo "已存在，跳过 ${name}（--force 可重下）"
    return 0
  fi

  mkdir -p "$DEST"
  tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/tidewatch-ffmpeg.XXXXXX")
  zip="$tmpdir/$name.zip"

  url="$RIEDL/$PLATFORM/$ARCH/release/$name.zip"
  if curl -fL --retry 2 --retry-delay 1 --connect-timeout 20 --max-time 600 \
    --silent --show-error -o "$zip" "$url" 2>"$tmpdir/err"; then
    source="martin-riedl"
  elif [ "$HAS_FALLBACK" -eq 1 ]; then
    echo "  主源失败（$(cat "$tmpdir/err" 2>/dev/null)），回退 evermeet" >&2
    v=$(meta "$name" version)
    url="$EVERMEET/$name-$v.zip"
    source="evermeet"
    if ! curl -fL --retry 2 --retry-delay 1 --connect-timeout 20 --max-time 900 \
      --silent --show-error -o "$zip" "$url"; then
      echo "  两个源都下不动，放弃。见 $url" >&2
      rm -rf "$tmpdir"
      exit 1
    fi
  else
    echo "  下载失败：$url" >&2
    cat "$tmpdir/err" >&2 || true
    rm -rf "$tmpdir"
    exit 1
  fi

  if ! unzip -o -q "$zip" -d "$tmpdir"; then
    echo "  解压失败：$zip" >&2
    rm -rf "$tmpdir"
    exit 1
  fi

  found=$(find "$tmpdir" -maxdepth 3 -type f -name "$name" | head -1)
  if [ -z "$found" ]; then
    echo "  压缩包里没有 ${name}，内容：$(ls -1 "$tmpdir")" >&2
    rm -rf "$tmpdir"
    exit 1
  fi

  mv -f "$found" "$target"
  chmod 755 "$target"
  version=$(version_of "$target")
  echo "  ${name} ${version}（${source}）→ ${target}"

  if [ -n "$EXPECT" ] && [ "$version" != "$EXPECT" ]; then
    echo "  版本不符：期望 ${EXPECT}，实际 ${version}" >&2
    rm -rf "$tmpdir"
    exit 1
  fi

  VERSIONS="${VERSIONS}${name} ${version} ${PLATFORM}/${ARCH} ${source}"$'\n'
  rm -rf "$tmpdir"
}

echo "平台 ${PLATFORM}/${ARCH}，目标 ${DEST}"
for name in $ONLY; do
  fetch_one "$name"
done

if [ -n "$VERSIONS" ]; then
  mkdir -p "$(dirname "$VERSION_FILE")"
  printf '%s' "$VERSIONS" >>"$VERSION_FILE"
fi

echo
echo "生效情况："
for name in $ONLY; do
  target="$DEST/$name"
  if [ -x "$target" ]; then
    printf '  %-8s %s\n' "$name" "$("$target" -version 2>&1 | head -1)"
  else
    printf '  %-8s （缺失）\n' "$name"
  fi
done
echo
echo "service.ts 在 TIDEWATCH_FFMPEG 未设置时会自动用 vendor 里的这份。"
echo "vendor/ 已在 .gitignore 中（层 B 平台相关件，不入库）。"
