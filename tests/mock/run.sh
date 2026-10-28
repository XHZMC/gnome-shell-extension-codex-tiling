#!/usr/bin/env bash
# 用「假的 GNOME Shell」跑真实的 lib/tilingManager.js：
# 真实的 Meta/Gio/GLib 类型库 + 打桩的 ui/main.js + 伪造的 global 对象，
# 因此不需要真实的显示服务器（沙箱里也起不来）就能验证需求 1~7 的流程。
set -euo pipefail

ext="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work="$(mktemp -d /tmp/codex-tiling-mock.XXXXXX)"
trap 'rm -rf "$work"' EXIT

# Mutter 的私有类型库在 /usr/lib/<arch>/mutter-<major>：挑版本号最大的那个，
# GNOME Shell 升级后不用改脚本。
mutter_dir=""
for dir in /usr/lib/*/mutter-*; do
    [ -d "$dir" ] || continue
    if [ -z "$mutter_dir" ] || [ "$(basename "$dir")" -gt "$(basename "$mutter_dir")" ] 2>/dev/null; then
        mutter_dir="$dir"
    fi
done
if [ -z "$mutter_dir" ]; then
    echo "找不到 mutter 的私有类型库（/usr/lib/*/mutter-*/）" >&2
    exit 1
fi

glib-compile-resources \
    --sourcedir="$ext/tests/mock/stub" \
    --target="$work/stub.gresource" \
    "$ext/tests/mock/stub.gresource.xml"

# 扩展自己的 schema + 假的 org.gnome.mutter（真机上由系统提供，这里只为验证
# 「接管 / 归还贴边吸附」这条链路）：编译到同一个目录里，避免依赖 schema 搜索路径
mkdir -p "$work/schemas"
cp "$ext"/schemas/*.gschema.xml "$work/schemas/"
cp "$ext"/tests/mock/schemas/*.gschema.xml "$work/schemas/"
glib-compile-schemas --strict "$work/schemas"

cd "$ext"
export GI_TYPELIB_PATH="/usr/lib/gnome-shell:$mutter_dir"
export LD_LIBRARY_PATH="/usr/lib/gnome-shell:$mutter_dir"
export GSETTINGS_BACKEND=memory
export GSETTINGS_SCHEMA_DIR="$work/schemas"

# stdbuf：gjs 的 print() 在管道里是块缓冲的，不实时刷新就看不到进度
stdbuf -oL -eL gjs -m tests/mock/managerFlow.gjs.js "$work/stub.gresource"
