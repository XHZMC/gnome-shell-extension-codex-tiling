#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# 在隔离的环境里启动一个 headless 的 GNOME Shell，加载扩展和测试用 harness 扩展，
# 把 client.py 生成的窗口当作真实客户端，跑一遍需求 1~7 的端到端验证。
#
# 用法： tests/live/run.sh [扩展目录]
#   CT_KEEP_SANDBOX=1   保留临时目录（默认保留，便于排查）
#   CT_SHELL_TIMEOUT=180  等待报告的秒数
set -uo pipefail

EXT_DIR=${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
EXT_DIR=$(cd "$EXT_DIR" && pwd)
UUID=codex-tiling@codex.local
HARNESS_UUID=codex-tiling-harness@local
LIVE_DIR="$EXT_DIR/tests/live"

# 会话总线：必须在自己的 dbus session 里跑，否则会用到宿主环境的总线
if [ -z "${CT_IN_SESSION:-}" ]; then
    unset DBUS_SESSION_BUS_ADDRESS
    export CT_IN_SESSION=1
    exec dbus-run-session -- "$0" "$@"
fi

if ! command -v gnome-shell >/dev/null; then
    echo "找不到 gnome-shell，无法运行端到端测试" >&2
    exit 2
fi

SANDBOX=$(mktemp -d "${TMPDIR:-/tmp}/codex-tiling-live.XXXXXX")
export XDG_RUNTIME_DIR="$SANDBOX/run"
export XDG_DATA_HOME="$SANDBOX/data"
export XDG_CONFIG_HOME="$SANDBOX/config"
export XDG_CACHE_HOME="$SANDBOX/cache"
export GSETTINGS_BACKEND=keyfile
export WAYLAND_DISPLAY=wayland-9
export NO_AT_BRIDGE=1
export GTK_A11Y=none

mkdir -p "$XDG_RUNTIME_DIR" "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME"
chmod 700 "$XDG_RUNTIME_DIR"

EXTENSIONS_DIR="$XDG_DATA_HOME/gnome-shell/extensions"
mkdir -p "$EXTENSIONS_DIR"
cp -r "$EXT_DIR" "$EXTENSIONS_DIR/$UUID"
mkdir -p "$EXTENSIONS_DIR/$HARNESS_UUID"
cp "$LIVE_DIR/harness.js" "$EXTENSIONS_DIR/$HARNESS_UUID/extension.js"
cp "$LIVE_DIR/harness-metadata.json" "$EXTENSIONS_DIR/$HARNESS_UUID/metadata.json"
glib-compile-schemas "$EXTENSIONS_DIR/$UUID/schemas"

export CT_CLIENT="$LIVE_DIR/client.py"
export CT_REPORT="$SANDBOX/report.json"
export CT_SCREENSHOT="$SANDBOX/tiling.png"
SHELL_LOG="$SANDBOX/shell.log"

gsettings set org.gnome.shell enabled-extensions "['$UUID', '$HARNESS_UUID']" >/dev/null 2>&1
gsettings set org.gnome.shell disable-user-extensions false >/dev/null 2>&1
gsettings set org.gnome.desktop.interface enable-animations false >/dev/null 2>&1
gsettings set org.gnome.mutter edge-tiling true >/dev/null 2>&1

echo "沙箱目录: $SANDBOX"
gnome-shell --headless --wayland --no-x11 \
    --wayland-display="$WAYLAND_DISPLAY" --virtual-monitor 1280x800 \
    > "$SHELL_LOG" 2>&1 &
SHELL_PID=$!

TIMEOUT=${CT_SHELL_TIMEOUT:-180}
for _ in $(seq 1 $((TIMEOUT * 2))); do
    [ -f "$CT_REPORT" ] && break
    if ! kill -0 "$SHELL_PID" 2>/dev/null; then
        echo "gnome-shell 意外退出，日志见 $SHELL_LOG" >&2
        break
    fi
    sleep 0.5
done

STATUS=1
if [ -f "$CT_REPORT" ]; then
    python3 - "$CT_REPORT" <<'PY'
import json, sys
report = json.load(open(sys.argv[1]))
print()
print('=' * 78)
print(f'端到端测试结果：{report["total"] - report["failed"]}/{report["total"]} 通过')
print('=' * 78)
for case in report['cases']:
    mark = 'PASS' if case['pass'] else 'FAIL'
    print(f'[{mark}] {case["name"]}')
    if case['detail']:
        print(f'        {case["detail"]}')
for note in report.get('notes', []):
    print(f'  · {note}')
print()
sys.exit(1 if report['failed'] else 0)
PY
    STATUS=$?
else
    echo "超时：没有生成测试报告（$CT_REPORT）" >&2
fi

echo '--- shell 日志中与被测扩展相关的行 ---'
grep -aE "codex-tiling|Codex Tiling|JS ERROR|TypeError|ENABLE|内部错误" "$SHELL_LOG" | tail -30

echo
echo "报告: $CT_REPORT"
echo "截图: $CT_SCREENSHOT"
echo "shell 日志: $SHELL_LOG"

kill "$SHELL_PID" 2>/dev/null
wait "$SHELL_PID" 2>/dev/null

if [ "${CT_KEEP_SANDBOX:-1}" != "1" ] && [ -d "$SANDBOX" ]; then
    rm -rf "$SANDBOX"
fi

exit $STATUS
