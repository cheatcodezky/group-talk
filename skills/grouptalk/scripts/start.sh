#!/bin/sh
set -eu

scripts=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
manifest="$scripts/node-release.txt"
cli="$scripts/../server/cli.mjs"

usable_node() {
  "$1" --no-warnings "$scripts/check-node.cjs" >/dev/null 2>&1
}

node_on_path=$(command -v node || true)
if [ -n "$node_on_path" ] && usable_node "$node_on_path"; then
  exec "$node_on_path" "$cli" "$@"
fi

fail() { printf 'GroupTalk: %s\n' "$*" >&2; exit 1; }
case $(uname -s) in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail '请先安装支持 SQLite 的 Node.js 22.13 或更高版本，并将 node 加入 PATH。Windows 可使用 start.ps1。' ;;
esac
case $(uname -m) in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) fail '当前架构需要手动安装支持 SQLite 的 Node.js 22.13 或更高版本。' ;;
esac

IFS= read -r version < "$manifest"
runtime_root=${GROUPTALK_RUNTIME_DIR:-"$HOME/.grouptalk/runtime"}
binary_dir="$runtime_root/$version/$os-$arch"
cached_node="$binary_dir/node"

install_node() (
  umask 077
  command -v curl >/dev/null 2>&1 || fail '安装 Node.js 需要 curl。可先安装 curl，或手动安装 Node.js。'
  command -v tar >/dev/null 2>&1 || fail '安装 Node.js 需要 tar。可先安装 tar，或手动安装 Node.js。'
  if command -v sha256sum >/dev/null 2>&1; then
    sha256() { sha256sum "$1"; }
  elif command -v shasum >/dev/null 2>&1; then
    sha256() { shasum -a 256 "$1"; }
  else
    fail '安装 Node.js 需要 sha256sum 或 shasum，以验证下载文件。'
  fi

  distribution="node-$version-$os-$arch"
  artifact="$distribution.tar.gz"
  expected=$(awk -v artifact="$artifact" '$2 == artifact { print $1 }' "$manifest")
  [ -n "$expected" ] || fail "缺少 $artifact 的 SHA-256。"
  mkdir -p "$binary_dir" || fail "无法写入运行时目录 $binary_dir。"
  temp=$(mktemp -d "$binary_dir/.download.XXXXXXXX")
  trap 'rm -rf -- "$temp"' 0
  trap 'exit 130' INT
  trap 'exit 143' TERM

  printf 'GroupTalk: 正在安装 Node.js %s 到 %s\n' "$version" "$binary_dir" >&2
  curl --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 180 --retry 2 -fsSL \
    "https://nodejs.org/dist/$version/$artifact" -o "$temp/$artifact" || fail '无法下载 Node.js，请检查到 nodejs.org 的网络连接。'
  actual=$(sha256 "$temp/$artifact")
  [ "${actual%% *}" = "$expected" ] || fail "Node.js 下载文件 $artifact 的 SHA-256 校验失败。"
  tar -xzf "$temp/$artifact" -C "$temp" "$distribution/bin/node" || fail '无法解压 Node.js。'
  staged_node="$temp/$distribution/bin/node"
  usable_node "$staged_node" || fail '下载的 Node.js 无法在当前系统运行。请安装适合此系统且支持 SQLite 的 Node.js。'
  mv -f -- "$staged_node" "$cached_node"
)

if ! usable_node "$cached_node"; then
  install_node
fi
exec "$cached_node" "$cli" "$@"
