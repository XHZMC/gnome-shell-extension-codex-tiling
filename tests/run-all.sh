#!/usr/bin/env bash
# 跑完所有不需要真实桌面会话的检查：
#   1. 纯布局逻辑（BSP 树 + 落点判定）—— node 单元测试
#   2. Meta / St / GSettings 接口存在性 —— 真实类型库 introspection
#   3. 完整管理器流程（假的 GNOME Shell）—— 需求 1~7
#
# 真机端到端（需要能起一个真实的 GNOME Shell 会话）： tests/live/run.sh
set -euo pipefail

ext="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ext"

echo "=== 1/3 纯布局逻辑单元测试"
# 注意：直接给目录参数在 node 24 下会被当成模块，这里用 glob
node --test "tests/*.test.mjs"

echo
echo "=== 2/3 接口存在性检查"
glib-compile-schemas "$ext/schemas"
tests/apiCheckEnv.sh gjs -m tests/apiCheck.gjs.js

echo
echo "=== 3/3 模拟 shell 的管理器流程"
./tests/mock/run.sh

echo
echo "全部检查通过（真机端到端另见 tests/live/run.sh）"
