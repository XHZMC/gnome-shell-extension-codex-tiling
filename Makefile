# Codex Tiling —— 构建 / 安装 / 测试
#
#   make test       跑所有不需要桌面会话的检查
#   make zip        打包成 ../../outputs/<uuid>.zip（可直接 gnome-extensions install）
#   make install    安装到 ~/.local/share/gnome-shell/extensions/ 并编译 schema
#   make live       真机会话里的端到端测试（需要能启动 GNOME Shell）
#   make clean      删掉打包产物

UUID = codex-tiling@codex.local
HERE := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
OUT  := $(abspath $(HERE)/../../outputs)
ZIP  := $(OUT)/$(UUID).zip
DEST := $(or $(XDG_DATA_HOME),$(HOME)/.local/share)/gnome-shell/extensions/$(UUID)

SHIPPED = metadata.json extension.js prefs.js stylesheet.css README.md lib schemas

.PHONY: all test api mock zip install live clean

all: zip

## 所有不需要桌面会话的检查
test:
	./tests/run-all.sh

api:
	glib-compile-schemas schemas
	./tests/apiCheckEnv.sh gjs -m tests/apiCheck.gjs.js

mock:
	./tests/mock/run.sh

## 打包（schema 一起编译进去，装完即可用）
zip: schemas/gschemas.compiled
	@mkdir -p "$(OUT)"
	@rm -f "$(ZIP)"
	@cd "$(HERE)" && zip -qr "$(ZIP)" $(SHIPPED)
	@unzip -l "$(ZIP)"

schemas/gschemas.compiled: schemas/*.gschema.xml
	glib-compile-schemas --strict schemas

install: schemas/gschemas.compiled
	@mkdir -p "$(DEST)"
	@cp -r $(SHIPPED) "$(DEST)/"
	glib-compile-schemas "$(DEST)/schemas"
	@echo "已安装到 $(DEST)"
	@echo "Wayland 会话需要重新登录；X11 可 Alt+F2 → r。然后：gnome-extensions enable $(UUID)"

live:
	./tests/live/run.sh

clean:
	@rm -f "$(ZIP)"
	@rm -f schemas/gschemas.compiled
