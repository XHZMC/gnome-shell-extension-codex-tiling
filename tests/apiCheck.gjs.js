// SPDX-License-Identifier: MIT
/*
 * apiCheck.gjs.js —— 核对扩展用到的 Meta / St / GSettings 接口在当前
 * Mutter / GNOME Shell 版本里确实存在，并核对代码里读写的设置项都在 schema 里。
 *
 * 运行： tests/run-all.sh （或单独 gjs -m tests/apiCheck.gjs.js）
 */

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

const failures = [];
const check = (label, ok, detail = '') => {
    if (!ok)
        failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};

/* --------------------------------------------------------------- Meta 枚举 */

const enums = {
    'Meta.WindowType.NORMAL': Meta.WindowType?.NORMAL,
    'Meta.MaximizeFlags.BOTH': Meta.MaximizeFlags?.BOTH,
    'Meta.GrabOp.MOVING': Meta.GrabOp?.MOVING,
    'Meta.GrabOp.MOVING_UNCONSTRAINED': Meta.GrabOp?.MOVING_UNCONSTRAINED,
    'Meta.GrabOp.KEYBOARD_MOVING': Meta.GrabOp?.KEYBOARD_MOVING,
    'Meta.GrabOp.RESIZING_N': Meta.GrabOp?.RESIZING_N,
    'Meta.GrabOp.RESIZING_E': Meta.GrabOp?.RESIZING_E,
    'Meta.GrabOp.RESIZING_S': Meta.GrabOp?.RESIZING_S,
    'Meta.GrabOp.RESIZING_W': Meta.GrabOp?.RESIZING_W,
    'Meta.GrabOp.RESIZING_NE': Meta.GrabOp?.RESIZING_NE,
    'Meta.GrabOp.RESIZING_NW': Meta.GrabOp?.RESIZING_NW,
    'Meta.GrabOp.RESIZING_SE': Meta.GrabOp?.RESIZING_SE,
    'Meta.GrabOp.RESIZING_SW': Meta.GrabOp?.RESIZING_SW,
};
for (const [label, value] of Object.entries(enums))
    check(label, value !== undefined);

/* ------------------------------------------------------------- Meta.Window */

const windowMethods = [
    'get_window_type', 'is_override_redirect', 'is_skip_taskbar', 'is_on_all_workspaces',
    'get_transient_for', 'is_monitor_sized', 'is_screen_sized',
    'get_wm_class', 'connect', 'disconnect',
    'minimize', 'unminimize', 'maximize', 'unmaximize',
    'get_maximize_flags', 'is_fullscreen', 'allows_resize',
    'move_resize_frame', 'move_frame', 'get_frame_rect',
    'get_monitor', 'get_workspace', 'get_user_time',
];
for (const method of windowMethods)
    check(`Meta.Window.prototype.${method}`, typeof Meta.Window.prototype[method] === 'function');

// 这两个「存在即用」（代码里用 ?. 兜底）：不同 mutter 版本不一定提供，
// 没有的时候窗口照常平铺，只是少一条判定理由。
for (const method of ['is_attached_dialog', 'is_modal']) {
    const present = typeof Meta.Window.prototype[method] === 'function';
    print(`[信息] Meta.Window.prototype.${method}：${present ? '存在' : '不存在（用兜底判定）'}`);
}

for (const property of ['minimized', 'fullscreen', 'maximized-horizontally', 'maximized-vertically'])
    check(`Meta.Window 属性 ${property}`, Meta.Window.find_property(property) !== null);

for (const signal of ['unmanaged', 'workspace-changed', 'size-changed', 'position-changed'])
    check(`Meta.Window 信号 ${signal}`, GObject.signal_lookup(signal, Meta.Window) !== 0);

/* ------------------------------------------------------------ Meta.Display */

for (const method of ['get_focus_window', 'list_all_windows', 'sort_windows_by_stacking'])
    check(`Meta.Display.prototype.${method}`, typeof Meta.Display.prototype[method] === 'function');
check('Meta.Display 属性 focus-window', Meta.Display.find_property('focus-window') !== null);

for (const signal of ['window-created', 'grab-op-begin', 'grab-op-end',
    'workareas-changed', 'window-entered-monitor'])
    check(`Meta.Display 信号 ${signal}`, GObject.signal_lookup(signal, Meta.Display) !== 0);

/* ------------------------------------- Meta.WorkspaceManager / Meta.Workspace */

for (const method of ['get_workspace_by_index', 'get_active_workspace_index'])
    check(`Meta.WorkspaceManager.prototype.${method}`,
        typeof Meta.WorkspaceManager.prototype[method] === 'function');

for (const method of ['index', 'get_work_area_for_monitor'])
    check(`Meta.Workspace.prototype.${method}`, typeof Meta.Workspace.prototype[method] === 'function');

/* -------------------------------------------------------------------- 其它 */

check('St.Widget 可用', typeof St.Widget === 'function');
for (const method of ['set_position', 'set_size', 'show', 'hide', 'destroy'])
    check(`St.Widget.prototype.${method}`, typeof St.Widget.prototype[method] === 'function');

// 需求 4：扩展要把 mutter 自己的边缘平铺关掉
const source = Gio.SettingsSchemaSource.get_default();
const mutterSchema = source?.lookup('org.gnome.mutter', true);
check('org.gnome.mutter 存在', !!mutterSchema);
if (mutterSchema) {
    check('org.gnome.mutter 有 edge-tiling 键',
        mutterSchema.list_keys().includes('edge-tiling'));
}

// 代码里读写的设置项都必须真的在 schema 里
const settings = new Gio.Settings({schema_id: 'org.gnome.shell.extensions.codex-tiling'});
const keys = settings.list_keys();
for (const key of ['enabled', 'gap', 'outer-gap', 'icon-area-inset', 'edge-threshold',
    'minimum-window-size', 'show-preview', 'show-overview-when-empty', 'rearrange-existing-windows',
    'preview-border-width', 'mutter-edge-tiling-backup'])
    check(`设置项 ${key}`, keys.includes(key));
check('设置项里不再有 take-over-edge-tiling（接管边缘平铺已改为总是开启）',
    !keys.includes('take-over-edge-tiling'));
check('show-overview-when-empty 默认关闭',
    settings.get_default_value('show-overview-when-empty').get_boolean() === false);
check('mutter-edge-tiling-backup 默认为空（表示当前没有在接管贴边吸附）',
    settings.get_string('mutter-edge-tiling-backup') === '');
check('preview-border-width 默认 6px',
    settings.get_int('preview-border-width') === 6);

/* --------------------------------------------- 元数据 / 当前 GNOME Shell 版本 */
// 类型库跟着 Shell 版本走（Meta-51、St-51……），所以顺便核对 metadata.json
// 声明支持的版本里包含当前装着的这个 —— Shell 升级之后这里会第一时间报出来。
let shellVersions = [];
try {
    const metadataPath = GLib.build_filenamev([GLib.get_current_dir(), 'metadata.json']);
    const [, contents] = GLib.file_get_contents(metadataPath);
    const metadata = JSON.parse(new TextDecoder().decode(contents));
    shellVersions = (metadata['shell-version'] ?? []).map(String);
} catch (error) {
    check('metadata.json 能解析', false, String(error));
}
let shellVersion = '';
try {
    const [ok, stdout] = GLib.spawn_command_line_sync('gnome-shell --version');
    if (ok)
        shellVersion = new TextDecoder().decode(stdout).trim();
} catch {
    shellVersion = '';
}
const shellMajor = /(\d+)(?:\.\d+)?\s*$/.exec(shellVersion)?.[1] ?? null;
print(`当前环境：${shellVersion || '未知'}；metadata 声明支持 ${shellVersions.join(' / ')}`);
check(`metadata.json 的 shell-version 包含当前 GNOME Shell ${shellMajor ?? '?'}`,
    !!shellMajor && shellVersions.includes(shellMajor),
    `shell-version=${shellVersions.join(',')} 当前=${shellVersion || '未知'}`);

/* ------------------------------------------------------------------ 样式表 */
const stylesheetPath = GLib.build_filenamev([GLib.get_current_dir(), 'stylesheet.css']);
const stylesheetFile = Gio.File.new_for_path(stylesheetPath);
check('stylesheet.css 存在', stylesheetFile.query_exists(null));

try {
    // 用 St 自己的 CSS 引擎过一遍，语法错误会在这里暴露
    const theme = new St.Theme();
    theme.load_stylesheet(stylesheetFile);
} catch (error) {
    check('stylesheet.css 能被 St 解析', false, String(error));
}

const [ok, contents] = GLib.file_get_contents(stylesheetPath);
if (ok) {
    const css = new TextDecoder().decode(contents);
    check('预览样式定义在 .codex-tiling-preview 上', css.includes('.codex-tiling-preview'));
    check('预览统一使用主题色 -st-accent-color', css.includes('-st-accent-color'));
    check('预览用高亮实心边框表示（CSS 默认 6px 实线主题色，实际宽度由 preview-border-width 决定）',
        /border:\s*6px solid -st-accent-color/.test(css));
    check('没有再按落点类型分颜色/样式类',
        !/codex-tiling-preview-(edge|between|swap|fill)/.test(css));
}

if (failures.length === 0) {
    print('OK 扩展用到的 Meta / St / GSettings 接口都存在于当前版本');
} else {
    for (const failure of failures)
        printerr(`MISSING ${failure}`);
    imports.system.exit(1);
}
