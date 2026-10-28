#!/usr/bin/env bash
# 把 GI 搜索路径指向 GNOME Shell / Mutter 的私有类型库后，再执行传入的命令。
# 用法： tests/apiCheckEnv.sh <命令...>
set -euo pipefail

ext="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Mutter 的私有类型库装在 /usr/lib/<arch>/mutter-<major>：按版本号挑最新的那个，
# 这样 GNOME Shell 升级（18 → 51 ……）不用改脚本。
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

export GI_TYPELIB_PATH="/usr/lib/gnome-shell:$mutter_dir"
export LD_LIBRARY_PATH="/usr/lib/gnome-shell:$mutter_dir"
export GSETTINGS_BACKEND="${GSETTINGS_BACKEND:-memory}"
# 扩展自己的 schema（apiCheck 会核对设置项）
export GSETTINGS_SCHEMA_DIR="${GSETTINGS_SCHEMA_DIR:-$ext/schemas}"

exec "$@"
