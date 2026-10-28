// SPDX-License-Identifier: MIT
/*
 * managerFlow.gjs.js —— 用假的 GNOME Shell 跑真实的 TilingManager。
 *
 * 覆盖需求 1~7 的流程（窗口创建 / 顶替 / 恢复最小化 / 拖放落点 / 联动缩放 /
 * 最大化 / 跨桌面移动），并检查「布局不能有空位」这个不变量：所有可见窗口的
 * 矩形必须不重叠、完全铺满工作区。
 *
 * 运行： tests/mock/run.sh
 */

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Gio from 'gi://Gio';

// 注意：这里不 import ../lib/tilingManager.js —— 它依赖 resource:///org/gnome/shell/ui/main.js
// 这个桩资源，必须先注册 gresource 再动态 import（见文件末尾）。
// 另外整个模块不能用顶层 await：在 gjs 里顶层 await 会让模块本身变成一个 job，
// 于是「在主循环里」的 promise 回调要等主循环结束才会执行（测试会假死）。

const AREA = {x: 0, y: 0, width: 1280, height: 800};

/* ------------------------------------------------------------------ 断言 */

const results = [];
const check = (name, pass, detail = '') => {
    results.push({name, pass: !!pass, detail: String(detail)});
    print(`${pass ? 'PASS' : 'FAIL'} ${name}${pass ? '' : ` — ${detail}`}`);
};

const fmt = rect => rect ? `(${rect.x},${rect.y} ${rect.width}x${rect.height})` : 'null';

const sameRect = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y &&
    a.width === b.width && a.height === b.height;

/**
 * 需求 8：除了最大化的窗口以外，任何两个窗口都不能重叠 ——
 * 也就是「平铺中的窗口」之间不能重叠（最大化窗口盖住别人是允许的）。
 */
function checkNoOverlap(label, windows) {
    const tiled = windows.filter(w => !w.minimized && w.get_maximize_flags() === 0);
    const rects = tiled.map(w => w.get_frame_rect());
    let overlaps = 0;
    for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
            const a = rects[i];
            const b = rects[j];
            const dx = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
            const dy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
            if (dx > 0 && dy > 0)
                overlaps++;
        }
    }
    check(`${label} · 可见窗口之间没有重叠`, overlaps === 0,
        `重叠 ${overlaps} 对；${windows.filter(w => !w.minimized)
            .map(w => `${w.title}${fmt(w.get_frame_rect())}`).join(' ')}`);
}

/** 需求 8：可见窗口必须不重叠，并且严丝合缝铺满工作区。 */
function checkNoGaps(label, windows, area = AREA) {
    if (windows.some(w => w.get_maximize_flags() !== 0)) {
        print(`[跳过] ${label} · 有空位检查（当前有最大化窗口铺满屏幕）`);
        return;
    }
    // 最小化的窗口不参与平铺；最大化的窗口由 mutter 铺满整个屏幕，也不参与
    const rects = windows
        .filter(w => !w.minimized && w.get_maximize_flags() === 0)
        .map(w => w.get_frame_rect());
    let overlap = 0;
    let area_sum = 0;
    for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        area_sum += r.width * r.height;
        if (r.x < area.x || r.y < area.y ||
            r.x + r.width > area.x + area.width || r.y + r.height > area.y + area.height) {
            check(`${label} · 窗口都在工作区内`, false, fmt(r));
            return;
        }
        for (let j = i + 1; j < rects.length; j++) {
            const s = rects[j];
            const dx = Math.min(r.x + r.width, s.x + s.width) - Math.max(r.x, s.x);
            const dy = Math.min(r.y + r.height, s.y + s.height) - Math.max(r.y, s.y);
            if (dx > 0 && dy > 0)
                overlap++;
        }
    }
    check(`${label} · 可见窗口互不重叠`, overlap === 0, `${overlap} 对重叠`);
    check(`${label} · 布局没有空位（正好铺满工作区）`,
        area_sum === area.width * area.height,
        `面积 ${area_sum} vs ${area.width * area.height}；${rects.map(fmt).join(' ')}`);
}

/**
 * 结构约束：布局只有「屏幕 → 列 → 行」两层，行里不能再切出列。
 * 也就是「行」（'v'）里面不允许再出现「列」（'h'）。
 */
function twoLevel(tree) {
    const walk = (node, insideRows) => {
        if (!node || node.kind === 'leaf')
            return true;
        const rows = insideRows || node.orientation === 'v';
        if (node.orientation === 'h' && rows)
            return false;
        return walk(node.first, rows) && walk(node.second, rows);
    };
    return walk(tree.root, false);
}

const checkTwoLevel = (label, tree) =>
    check(`${label} · 布局只有「列 → 行」两层（行里没有多出列）`, twoLevel(tree));

/* -------------------------------------------------------------------- 假 shell */

class Emitter {
    constructor() {
        this._handlers = new Map();
        this._nextHandle = 1;
    }

    connect(name, callback) {
        const id = this._nextHandle++;
        if (!this._handlers.has(name))
            this._handlers.set(name, new Map());
        this._handlers.get(name).set(id, callback);
        return id;
    }

    disconnect(id) {
        for (const handlers of this._handlers.values()) {
            if (handlers.delete(id))
                return;
        }
    }

    emit(name, ...args) {
        for (const callback of [...(this._handlers.get(name)?.values() ?? [])])
            callback(this, ...args);
    }
}

class MockWorkspace {
    constructor(manager, index) {
        this._manager = manager;
        this._index = index;
    }

    index() {
        return this._index;
    }

    /** 系统删掉别的桌面时，后面的桌面索引会整体前移（对象本身不变）。 */
    _setIndex(index) {
        this._index = index;
    }

    get_work_area_for_monitor(_monitor) {
        return {...AREA};
    }

    list_windows() {
        return this._manager.windows.filter(window => window._workspaceIndex === this._index);
    }
}

class MockWindow extends Emitter {
    constructor(display, title, workspace = 0) {
        super();
        this.display = display;
        this.title = title;
        this.minimized = false;
        // 注意：gjs 里 Meta.MaximizeFlags.NONE 是 undefined，用 0 表示「没有最大化」
        this._flags = 0;
        this._fullscreen = false;
        this._workspaceIndex = workspace;
        this._monitor = 0;
        this._rect = {x: 420, y: 260, width: 640, height: 400};
        this._userTime = 0;
    }

    /* ---- Meta.Window 中扩展会用到的那部分 ---- */
    get_window_type() {
        return this._windowType ?? Meta.WindowType.NORMAL;
    }

    is_attached_dialog() {
        return this._attachedDialog === true;
    }

    is_modal() {
        return this._modal === true;
    }

    is_override_redirect() {
        return false;
    }

    is_skip_taskbar() {
        return this._skipTaskbar === true;
    }

    is_on_all_workspaces() {
        return false;
    }

    get_transient_for() {
        return this._transientFor ?? null;
    }

    is_monitor_sized() {
        // mutter 的语义：全屏窗口也算「铺满显示器」
        return this._fullscreen || this._monitorSized === true;
    }

    is_screen_sized() {
        return false;
    }

    is_fullscreen() {
        return this._fullscreen;
    }

    /** 切换全屏（模拟用户 / 视频全屏）。 */
    setFullscreen(value) {
        if (this._fullscreen === value)
            return;
        this._fullscreen = value;
        this.emit('notify::fullscreen');
    }

    get_maximize_flags() {
        return this._flags;
    }

    allows_resize() {
        return true;
    }

    get_monitor() {
        return this._monitor;
    }

    get_workspace() {
        return this.display.workspace(this._workspaceIndex);
    }

    get_user_time() {
        return this._userTime;
    }

    /** 模拟用户动手碰了这个窗口（点标题栏、双击标题栏……）：用户操作时间前进。 */
    touchedByUser() {
        this._userTime = ++this.display.userTimeCounter;
    }

    get_frame_rect() {
        return {...this._rect};
    }

    minimize() {
        if (this.minimized)
            return;
        this.minimized = true;
        this.emit('notify::minimized');
    }

    unminimize() {
        if (!this.minimized)
            return;
        this.minimized = false;
        this.emit('notify::minimized');
    }

    maximize(flags = Meta.MaximizeFlags.BOTH) {
        if (this._flags === 0)
            this._preMaximizeRect = {...this._rect}; // mutter 会记住最大化之前的几何
        this._flags = flags;
        this._rect = {...AREA};   // 真实的 mutter 会把窗口铺满工作区
        this.emit('notify::maximized-horizontally');
        this.emit('notify::maximized-vertically');
    }

    unmaximize(_flags = Meta.MaximizeFlags.BOTH) {
        if (this._flags === 0)
            return;
        this._flags = 0;
        if (this._preMaximizeRect) {
            const restored = {...this._preMaximizeRect};
            this._preMaximizeRect = null;
            if (this.delayRestore) {
                // mutter 恢复「最大化前的几何」是异步的：可能落在扩展摆好布局之后
                this.display.later(120, () => {
                    this._rect = restored;
                    this.emit('position-changed');
                    this.emit('size-changed');
                });
            } else {
                this._rect = restored;
            }
        }
        this.emit('notify::maximized-horizontally');
        this.emit('notify::maximized-vertically');
    }

    move_resize_frame(_user, x, y, width, height) {
        this.moves = (this.moves ?? 0) + 1;
        if (this.ignoreNextResize) {
            // 模拟「这一次没照做」（慢半拍）—— 扩展会为此安排一次复核
            this.ignoreNextResize = false;
            return;
        }
        // 模拟客户端自己的尺寸限制：mutter 只能给到客户端允许的尺寸
        width = Math.max(width, this.minWidth ?? 1);
        height = Math.max(height, this.minHeight ?? 1);
        const moved = this._rect.x !== x || this._rect.y !== y;
        const resized = this._rect.width !== width || this._rect.height !== height;
        this._rect = {x, y, width, height};
        if (moved)
            this.emit('position-changed');
        if (resized)
            this.emit('size-changed');
    }

    move_frame(_user, x, y) {
        this.move_resize_frame(_user, x, y, this._rect.width, this._rect.height);
    }

    /* ---- 测试里用来模拟「用户操作」的小工具 ---- */
    /** 模拟 mutter 记着一个旧的最大化前矩形（例如窗口是在平铺之前就被最大化的）。 */
    simulateStaleMaximizeRect(rect) {
        this._preMaximizeRect = {...rect};
    }

    /** 模拟「用户拖动边缘」：几何直接跟着指针变，不经过扩展的几何请求。 */
    resizeTo(rect) {
        const moved = this._rect.x !== rect.x || this._rect.y !== rect.y;
        const resized = this._rect.width !== rect.width || this._rect.height !== rect.height;
        this._rect = {...rect};
        if (moved)
            this.emit('position-changed');
        if (resized)
            this.emit('size-changed');
    }

    moveToWorkspace(index) {
        this._workspaceIndex = index;
        this.emit('workspace-changed');
    }

    destroy() {
        this.emit('unmanaged');
    }
}

class MockDisplay extends Emitter {
    constructor() {
        super();
        this.userTimeCounter = 0;
        this.windows = [];
        this._focus = null;
        this._workspaces = [];
        this._pointer = [0, 0];
    }

    workspace(index) {
        while (this._workspaces.length <= index) {
            const workspace = new MockWorkspace(this, this._workspaces.length);
            this._workspaces.push(workspace);
            if (this._workspaces.length > 1)
                this.emit('workspace-added');
        }
        return this._workspaces[index];
    }

    createWindow(title, workspaceIndex = 0) {
        const window = new MockWindow(this, title, workspaceIndex);
        this.windows.push(window);
        this._focus = window;
        this.emit('notify::focus-window');
        this.emit('window-created', window);
        return window;
    }

    /**
     * 造一个「附加的模态窗口」：没有 transient、类型也是 NORMAL，
     * 只声明了模态 —— 用来验证模态判据本身在起作用。
     */
    createModalWindow(title, workspaceIndex = 0) {
        const window = new MockWindow(this, title, workspaceIndex);
        window._modal = true;
        this.windows.push(window);
        this._focus = window;
        this.emit('notify::focus-window');
        this.emit('window-created', window);
        return window;
    }

    /** 造一个对话框：附属在 parent 上，mutter 也只当它是附属对话框。 */
    createDialog(title, parent, workspaceIndex = 0) {
        const window = new MockWindow(this, title, workspaceIndex);
        window._windowType = Meta.WindowType.DIALOG;
        window._attachedDialog = true;
        window._transientFor = parent;
        this.windows.push(window);
        this._focus = window;
        this.emit('notify::focus-window');
        this.emit('window-created', window);
        return window;
    }

    get_focus_window() {
        return this._focus;
    }

    get_n_monitors() {
        return 1;
    }

    list_all_windows() {
        return [...this.windows];
    }

    sort_windows_by_stacking(windows) {
        return windows;
    }

    get_workspace_by_index(index) {
        return this.workspace(index);
    }

    get_active_workspace_index() {
        return this._activeWorkspace ?? 0;
    }

    get_active_workspace() {
        return this.workspace(this.get_active_workspace_index());
    }

    activateWorkspace(index) {
        this._activeWorkspace = index;
        this.workspace(index);
    }

    get_pointer() {
        return this._pointer;
    }

    focus(window) {
        this._focus = window;
        this.emit('notify::focus-window');
    }

    pointer(x, y) {
        this._pointer = [x, y];
    }

    /**
     * 模拟系统自动删除一个空桌面：工作区对象本身保留，后面的索引整体前移，
     * 它上面的窗口索引也跟着前移。
     */
    removeWorkspace(index) {
        if (index < 0 || index >= this._workspaces.length)
            return false;
        this._workspaces.splice(index, 1);
        this._workspaces.forEach((workspace, i) => workspace._setIndex(i));
        for (const window of this.windows) {
            if (window._workspaceIndex > index)
                window._workspaceIndex -= 1;
        }
        if ((this._activeWorkspace ?? 0) >= this._workspaces.length)
            this._activeWorkspace = Math.max(0, this._workspaces.length - 1);
        this.emit('workspace-removed', index);
        return true;
    }

    /** 按毫秒安排一件「稍后发生的事」（模拟合成器的异步行为）。 */
    later(ms, callback) {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            callback();
            return GLib.SOURCE_REMOVE;
        });
    }
}

/* ------------------------------------------------------------------ 主流程 */

const loop = GLib.MainLoop.new(null, false);

const sleep = ms => new Promise(resolve => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    });
});

/** 等扩展里那些 GLib.idle_add 的延迟处理跑完。 */
const settle = async () => {
    for (let i = 0; i < 6; i++)
        await sleep(20);
};

async function suite(TilingManager) {
    print('— 模拟 shell 流程开始 —');
    const display = new MockDisplay();
    const settings = new Gio.Settings({schema_id: 'org.gnome.shell.extensions.codex-tiling'});
    settings.set_boolean('show-preview', false);

    // 真实的 GNOME Shell 进程里 `global` 就是全局对象；普通 gjs 里没有这个名字，
    // 所以先补上别名，再把假的 display 挂到全局对象上 —— 扩展代码里的
    // global.display / global.workspace_manager 就会读到它们。
    globalThis.global ??= globalThis;
    globalThis.display = display;
    globalThis.workspace_manager = display;
    globalThis.get_pointer = () => display.get_pointer();
    globalThis.get_current_time = () => 1;

    const manager = new TilingManager(settings, console);
    manager.enable();
    await settle();

    /* ---------------- 需求 1 ---------------- */
    const w1 = display.createWindow('w1');
    await settle();
    check('需求1 · 第一个窗口铺满整个工作区（不是最大化）',
        sameRect(w1.get_frame_rect(), AREA) && w1.get_maximize_flags() === 0,
        `${fmt(w1.get_frame_rect())} flags=${w1.get_maximize_flags()}`);
    check('需求1 · 布局里只有这一个窗口',
        manager.store.get(0, 0).tree.windows().length === 1);
    checkNoGaps('需求1', [w1]);

    /* ---------------- 需求 2：新窗口不再顶替，按通常方式平铺 ---------------- */
    const w2 = display.createWindow('w2');
    await settle();
    const twoLayout = manager.store.get(0, 0);
    twoLayout.tree.layout(AREA);
    const w1Cell = twoLayout.tree.rectFor(w1);
    const w2Cell = twoLayout.tree.rectFor(w2);
    check('需求2 · 两个窗口都参与平铺，谁也没被最小化',
        !w1.minimized && !w2.minimized && twoLayout.tree.windows().length === 2,
        `w1.minimized=${w1.minimized} w2.minimized=${w2.minimized} ` +
        `windows=${twoLayout.tree.windows().length}`);
    check('需求2 · 新窗口上下平铺在原来的窗口旁边（不是接管它的位置）',
        !!w1Cell && !!w2Cell && w2Cell.x === w1Cell.x && w2Cell.width === w1Cell.width &&
        w2Cell.y === w1Cell.y + w1Cell.height,
        `w1=${fmt(w1Cell)} w2=${fmt(w2Cell)}`);
    checkNoGaps('需求2', [w1, w2]);

    /* ---------------- 需求 3：最小化再还原 → 回到原位 ---------------- */
    w2.minimize();
    await settle();
    check('需求3 · 最小化后兄弟窗口吸收它腾出的空间',
        sameRect(w1.get_frame_rect(), AREA), fmt(w1.get_frame_rect()));
    w2.unminimize();
    await settle();
    twoLayout.tree.layout(AREA);
    check('需求3 · 还原后回到最小化之前的格子',
        !w2.minimized && twoLayout.tree.windows().length === 2 &&
        sameRect(w2.get_frame_rect(), twoLayout.tree.rectFor(w2)) &&
        sameRect(w1.get_frame_rect(), twoLayout.tree.rectFor(w1)),
        `${fmt(w1.get_frame_rect())} / ${fmt(w2.get_frame_rect())}`);
    checkNoGaps('需求3', [w1, w2]);

    /* ---------------- 需求 4a：拖到另一个窗口的边 ---------------- */
    display.pointer(AREA.x + 4, AREA.y + 40);
    manager.dropAt(w2, AREA.x + 4, AREA.y + 40);   // 落在 w1 格子的左侧边缘上
    await settle();
    check('需求4a · 拖到窗口左侧边缘 → 在旁边插出一个新分栏',
        w2.get_frame_rect().x === AREA.x &&
        w2.get_frame_rect().x + w2.get_frame_rect().width === w1.get_frame_rect().x,
        `w2=${fmt(w2.get_frame_rect())} w1=${fmt(w1.get_frame_rect())}`);
    checkNoGaps('需求4a', [w1, w2]);
    checkTwoLevel('需求4a', manager.store.get(0, 0).tree);

    /* ---------------- 准备三个可见窗口（4b / 4c / 5 需要更多窗口） ---------------- */
    const w3 = display.createWindow('w3');
    await settle();
    for (const window of [w1, w2, w3].filter(w => w && w.minimized))
        window.unminimize();
    await settle();
    const layout = manager.store.get(0, 0);
    layout.tree.layout(AREA);
    const all = [w1, w2, w3];
    check('准备 · 三个窗口同时参与平铺',
        layout.tree.windows().length === 3 && all.every(w => !w.minimized),
        `windows=${layout.tree.windows().length} ` +
        all.map(w => `${w.title}:${w.minimized ? 'min' : 'ok'}`).join(' '));
    checkNoGaps('准备', all);

    /* ---------------- 需求 4b：拖到两个窗口中间 ---------------- */
    layout.tree.layout(AREA);
    const dragged = w2;
    // 挑一条「指针所在位置两侧都不是被拖动窗口」的分界线；
    // 一条分界线可能横贯整个工作区，只有指针附近真正相邻的两个窗口才算邻居。
    let boundary = null;
    let neighbours = null;
    let along = 0;
    for (const candidate of layout.tree.boundaries()) {
        // 沿着分界线取几个采样点，找一个「两侧都不是被拖动窗口」的位置
        for (let k = 1; k <= 5 && !boundary; k++) {
            const at = candidate.from + Math.round((candidate.to - candidate.from) * k / 6);
            const adjacent = layout.tree.leavesAtBoundary(candidate, at);
            const pair = [adjacent.before.window, adjacent.after.window];
            if (!pair.includes(dragged)) {
                boundary = candidate;
                neighbours = pair;
                along = at;
            }
        }
        if (boundary)
            break;
    }
    if (!boundary) {
        boundary = layout.tree.boundaries()[0];
        along = boundary.from + Math.round((boundary.to - boundary.from) / 2);
        const adjacent = layout.tree.leavesAtBoundary(boundary, along);
        neighbours = [adjacent.before.window, adjacent.after.window];
    }
    const pointer = boundary.orientation === 'h'
        ? [boundary.position, along]
        : [along, boundary.position];
    display.pointer(pointer[0], pointer[1]);
    manager.dropAt(dragged, pointer[0], pointer[1]);
    await settle();
    const order = layout.tree.windows();
    const index = order.indexOf(dragged);
    check('需求4b · 拖到两个窗口中间 → 插到它们之间',
        index > 0 && index < order.length - 1 &&
        neighbours.includes(order[index - 1]) && neighbours.includes(order[index + 1]),
        `顺序 ${order.map(w => w.title).join(' | ')}；` +
        `目标邻居 ${neighbours.map(w => w.title).join(' 与 ')}；` +
        `分界线 ${boundary.orientation}@${boundary.position} [${boundary.from},${boundary.to}] 指针 ${pointer.join(',')}`);
    check('需求4b · 两个分栏之间插入的新窗口是一整列（占满工作区高度）',
        layout.tree.rectFor(dragged).height === AREA.height,
        fmt(layout.tree.rectFor(dragged)));
    checkNoGaps('需求4b', all);
    checkTwoLevel('需求4b', layout.tree);

    /* ---------------- 需求 4c：拖到另一个窗口上 → 交换 ---------------- */
    layout.tree.layout(AREA);
    const targetLeaf = layout.tree.leaves().find(leaf => leaf.window !== dragged);
    const draggedRect = layout.tree.rectFor(dragged);
    const targetRect = layout.tree.rectFor(targetLeaf.window);
    display.pointer(
        targetRect.x + Math.round(targetRect.width / 2),
        targetRect.y + Math.round(targetRect.height / 2));
    manager.dropAt(dragged, display.get_pointer()[0], display.get_pointer()[1]);
    await settle();
    check('需求4c · 拖到另一个窗口的格子上 → 两个窗口交换位置',
        sameRect(dragged.get_frame_rect(), targetRect) &&
        sameRect(targetLeaf.window.get_frame_rect(), draggedRect),
        `被拖动 ${fmt(draggedRect)}→${fmt(dragged.get_frame_rect())}；` +
        `目标 ${fmt(targetRect)}→${fmt(targetLeaf.window.get_frame_rect())}`);
    checkNoGaps('需求4c', all);
    checkTwoLevel('需求4c', layout.tree);

    /* ---------------- 需求 5：拖动窗口边缘，其余窗口联动 ---------------- */
    layout.tree.layout(AREA);
    const columnBoundary = layout.tree.boundaries().find(b => b.orientation === 'h');
    const left = columnBoundary?.before.window ?? null;
    const right = columnBoundary?.after.window ?? null;
    if (left && right) {
        const targetWidth = 240;
        const rect = layout.tree.rectFor(left);
        // 模拟用户抓住左窗口的右边缘（也就是这条分界线）往左拖
        const requestedEdge = rect.x + targetWidth;
        left.resizeTo({x: rect.x, y: rect.y, width: targetWidth, height: rect.height});
        manager.commitResize(left, ['e']);
        await settle();
        layout.tree.layout(AREA);
        const expected = layout.tree.rectFor(left);
        const partnerRect = layout.tree.rectFor(right);
        check('需求5 · 抓住窗口右边缘拖动 → 分界线跟着走，右侧窗口联动缩放',
            expected.x + expected.width === requestedEdge &&
            partnerRect.x === requestedEdge &&
            sameRect(left.get_frame_rect(), expected) &&
            sameRect(right.get_frame_rect(), partnerRect),
            `期望分界线 ${requestedEdge}，实际 ${expected.x + expected.width}；` +
            `被拖动 ${fmt(expected)} 实际 ${fmt(left.get_frame_rect())}；` +
            `伙伴 ${fmt(partnerRect)} 实际 ${fmt(right.get_frame_rect())}`);
        print(`[提示] 联动缩放后：${layout.tree.windows()
            .map(w => `${w.title}${fmt(layout.tree.rectFor(w))}`).join(' ')}`);
    } else {
        check('需求5 · 拖动窗口边缘后其余窗口联动调整大小', false, '没有可用的左右相邻窗口');
    }
    checkNoGaps('需求5', all);
    checkTwoLevel('需求5', layout.tree);

    /* ---------------- 需求 6：最大化 ---------------- */
    const visible = all.filter(w => !w.minimized);
    const [first, second] = visible;
    const snapshot = visible.map(w => ({window: w, rect: w.get_frame_rect()}));
    first.touchedByUser();   // 用户按下的最大化（而不是窗口自己带出来的）
    first.maximize(Meta.MaximizeFlags.BOTH);
    await settle();
    check('需求6 · 最大化正常生效', first.get_maximize_flags() === Meta.MaximizeFlags.BOTH);
    check('需求6 · 最大化不影响其它窗口（它们留在原来的格子里，被最大化窗口盖住）',
        snapshot.filter(s => s.window !== first)
            .every(s => !s.window.minimized && sameRect(s.window.get_frame_rect(), s.rect)),
        snapshot.filter(s => s.window !== first)
            .map(s => `${s.window.title}:${fmt(s.window.get_frame_rect())} vs ${fmt(s.rect)}`).join('; '));
    checkNoOverlap('需求6 · 最大化期间（平铺窗口之间）', display.windows);
    checkNoGaps('需求6 · 最大化期间（平铺窗口仍然铺满）', visible);

    // 取消最大化 → 布局原样恢复（其它窗口的矩形不变），然后再验证换成第二个窗口最大化
    first.unmaximize(Meta.MaximizeFlags.BOTH);
    await settle();
    check('需求6 · 取消最大化后恢复最大化之前的布局',
        snapshot.every(s => !s.window.minimized && sameRect(s.window.get_frame_rect(), s.rect)),
        snapshot.map(s => `${s.window.title}:${fmt(s.window.get_frame_rect())} vs ${fmt(s.rect)}`)
            .join('; '));
    checkNoGaps('需求6 · 取消最大化后', visible);
    checkNoOverlap('需求6 · 取消最大化后', display.windows);

    second.touchedByUser();
    second.maximize(Meta.MaximizeFlags.BOTH);
    await settle();
    check('需求6 · 每个桌面最多一个可见的最大化窗口',
        second.get_maximize_flags() === Meta.MaximizeFlags.BOTH && !second.minimized &&
        first.get_maximize_flags() === 0 &&
        display.windows.filter(w => !w.minimized && w.get_maximize_flags() !== 0).length === 1,
        `可见最大化窗口数=${display.windows.filter(w => !w.minimized && w.get_maximize_flags() !== 0).length}；` +
        `first: flags=${first.get_maximize_flags()} minimized=${first.minimized}；` +
        `second: flags=${second.get_maximize_flags()} minimized=${second.minimized}`);
    checkNoOverlap('需求6 · 第二个窗口最大化期间', display.windows);

    second.unmaximize(Meta.MaximizeFlags.BOTH);
    await settle();
    checkNoGaps('需求6 · 再次取消最大化后', visible);
    checkNoOverlap('需求6 · 再次取消最大化后', display.windows);

    /* ---------------- 需求 6 续：下一个窗口接着最大化 ---------------- */
    first.maximize(Meta.MaximizeFlags.BOTH);
    await settle();
    const survivorRects = visible.filter(w => w !== first)
        .map(w => ({window: w, rect: w.get_frame_rect()}));
    first.destroy();
    display.windows = display.windows.filter(w => w !== first);
    await settle();
    check('需求6 · 最大化窗口被关掉后其余窗口铺满',
        survivorRects.every(s => !s.window.minimized) &&
        (() => {
            const sum = display.windows.filter(w => !w.minimized)
                .reduce((total, w) => {
                    const r = w.get_frame_rect();
                    return total + r.width * r.height;
                }, 0);
            return sum === AREA.width * AREA.height;
        })(),
        display.windows.filter(w => !w.minimized).map(w => `${w.title}:${fmt(w.get_frame_rect())}`).join(' '));

    // 回归：最大化窗口被关掉之后，焦点窗口并不是最大化窗口，
    // 此时新开的窗口必须是平铺的 —— 不能把「最大化」当成一种会一直留着的历史状态。
    const w4 = display.createWindow('w4');
    await settle();
    check('需求6 · 关掉最大化窗口之后新开的窗口是平铺的（不追认历史状态）',
        w4.get_maximize_flags() === 0 && !w4.minimized && layout.tree.findLeaf(w4) !== null,
        `flags=${w4.get_maximize_flags()} minimized=${w4.minimized}`);
    checkNoGaps('需求6 续', display.windows);
    checkNoOverlap('需求6 续', display.windows);

    // 有窗口最大化时新开窗口：焦点切走 → 原来那个窗口取消最大化（不会传给新窗口），
    // 新窗口按普通窗口平铺
    w4.touchedByUser();
    w4.maximize(Meta.MaximizeFlags.BOTH);
    await settle();
    const switchLayout = manager.store.get(0, 0);
    const w5 = display.createWindow('w5');
    await settle();
    switchLayout.tree.layout(AREA);
    const w5Cell = switchLayout.tree.rectFor(w5);
    check('需求6 · 新窗口打开时，原来最大化的窗口取消最大化（不传给新窗口）',
        w4.get_maximize_flags() === 0 && switchLayout.maximized === null &&
        !switchLayout.paused && !w4.minimized,
        `w4.flags=${w4.get_maximize_flags()} maximized=${switchLayout.maximized?.title ?? 'null'} ` +
        `paused=${switchLayout.paused}`);
    check('需求6 · 原来的窗口回到平铺状态（在自己当前的格子里）',
        sameRect(w4.get_frame_rect(), switchLayout.tree.rectFor(w4)),
        `${fmt(w4.get_frame_rect())} 期望 ${fmt(switchLayout.tree.rectFor(w4))}`);
    check('需求6 · 新窗口是插进「最左下」那个窗口的下半部分',
        w5Cell?.x === 0 && w5Cell?.y + w5Cell?.height === AREA.height,
        `w5=${fmt(w5Cell)}`);
    check('需求6 · 新窗口是普通平铺窗口',
        w5.get_maximize_flags() === 0 && !w5.minimized &&
        switchLayout.tree.findLeaf(w5) !== null &&
        switchLayout.tree.findLeaf(w4) !== null,
        `w5.flags=${w5.get_maximize_flags()} windows=${switchLayout.tree.windows().length}`);

    // 从最大化的窗口切到另一个窗口：只取消它的最大化，不把最大化带给新焦点
    w4.touchedByUser();
    w4.maximize(Meta.MaximizeFlags.BOTH);
    await settle();
    const focusTarget = display.windows.find(w =>
        w !== w4 && !w.minimized && switchLayout.tree.findLeaf(w));
    if (focusTarget) {
        switchLayout.tree.layout(AREA);
        const cellBefore = switchLayout.tree.rectFor(w4);
        display.focus(focusTarget);
        await settle();
        switchLayout.tree.layout(AREA);
        check('需求6 · 切走焦点只取消原来的最大化，新焦点保持普通平铺',
            w4.get_maximize_flags() === 0 && switchLayout.maximized === null &&
            !switchLayout.paused &&
            focusTarget.get_maximize_flags() === 0 && !focusTarget.minimized,
            `w4.flags=${w4.get_maximize_flags()} ${focusTarget.title}.flags=${focusTarget.get_maximize_flags()}`);
        check('需求6 · 原来的窗口回到它自己的格子',
            sameRect(w4.get_frame_rect(), cellBefore),
            `${fmt(w4.get_frame_rect())} 期望 ${fmt(cellBefore)}`);
    } else {
        check('需求6 · 切走焦点只取消原来的最大化', false, '没有可切换的窗口');
    }

    for (const window of display.windows.filter(w => w.get_maximize_flags() !== 0)) {
        window.touchedByUser();
        window.unmaximize(Meta.MaximizeFlags.BOTH);
    }
    await settle();
    checkNoGaps('需求6 续 · 取消最大化', display.windows);
    checkNoOverlap('需求6 续 · 取消最大化', display.windows);

    /* ---------------- 需求 7：移动到别的工作区 ---------------- */
    display.workspace(1);
    const mover = display.windows.find(w => !w.minimized && w !== w4);
    if (mover) {
        mover.moveToWorkspace(1);
        await settle();
        check('需求7 · 移到空白桌面 → 铺满该桌面（不被最小化）',
            !mover.minimized && sameRect(mover.get_frame_rect(), AREA),
            `minimized=${mover.minimized} ${fmt(mover.get_frame_rect())}`);

        mover.moveToWorkspace(0);
        await settle();
        const backLayout = manager.store.get(0, 0);
        backLayout.tree.layout(AREA);
        check('需求7 · 移回非空白桌面 → 参与平铺（不被最小化）',
            mover.minimized === false && backLayout.tree.findLeaf(mover) !== null &&
            sameRect(mover.get_frame_rect(), backLayout.tree.rectFor(mover)),
            `minimized=${mover.minimized} ${fmt(mover.get_frame_rect())} ` +
            `期望 ${fmt(backLayout.tree.rectFor(mover))}`);
        // 自动安置一律「上下平铺」：它与某个窗口同一列（x 与宽度相同），而不是并排的新分栏
        const moverCell = backLayout.tree.rectFor(mover);
        const sameColumn = backLayout.tree.windows()
            .filter(w => w !== mover)
            .map(w => backLayout.tree.rectFor(w))
            .filter(rect => rect && rect.x === moverCell.x && rect.width === moverCell.width);
        check('需求7 · 挪过来的窗口是上下平铺（同一列里的新一行，不是新分栏）',
            sameColumn.length > 0,
            `mover=${fmt(moverCell)} 同列窗口=${sameColumn.map(fmt).join(' ') || '无'}`);
        checkNoGaps('需求7 · 移回之后', backLayout.tree.windows());
        checkNoOverlap('需求7 · 移回之后', backLayout.tree.windows());
    } else {
        check('需求7 · 移动到别的工作区', false, '没有可移动的窗口');
    }

    /* ---------------- 需求 2：关掉第二个窗口不会自动把上一个窗口调回来 ---------------- */
    const fresh = 2;
    display.workspace(fresh);
    const r1 = display.createWindow('r1', fresh);
    await settle();
    const r2 = display.createWindow('r2', fresh);
    await settle();
    const freshLayout = manager.store.get(fresh, 0);
    check('需求2 · 第二个窗口平铺进来，两个都参与平铺',
        !r1.minimized && !r2.minimized && freshLayout.tree.windows().length === 2,
        `r1.minimized=${r1.minimized} r2.minimized=${r2.minimized} ` +
        `windows=${freshLayout.tree.windows().length}`);

    r2.destroy();
    display.windows = display.windows.filter(w => w !== r2);
    await settle();
    check('需求2 · 关掉第二个窗口 → 第一个窗口吸收空间、继续平铺',
        !r1.minimized && freshLayout.tree.windows().length === 1 &&
        sameRect(r1.get_frame_rect(), AREA),
        `r1.minimized=${r1.minimized} windows=${freshLayout.tree.windows().length} ` +
        `${fmt(r1.get_frame_rect())}`);

    /* ---------------- 根节点：底部图标停靠区不参与平铺 ---------------- */
    settings.set_int('icon-area-inset', 40);
    display.workspace(3);
    const insetWindow = display.createWindow('inset', 3);
    await settle();
    const insetArea = {...AREA, height: AREA.height - 40};
    check('根节点 · 底部图标停靠区留白被排除在根节点之外',
        sameRect(insetWindow.get_frame_rect(), insetArea),
        `${fmt(insetWindow.get_frame_rect())} 期望 ${fmt(insetArea)}`);
    settings.set_int('icon-area-inset', 0);
    await settle();

    /* ---------------- 需求 6 补充：新窗口自己带出来的最大化要取消 ---------------- */
    const freshWorkspace = 4;
    display.workspace(freshWorkspace);
    const m1 = display.createWindow('m1', freshWorkspace);
    m1.minHeight = 600;   // 这个窗口不肯低于 600 高（在它第一次落位之前就声明）
    await settle();
    const m2 = display.createWindow('m2', freshWorkspace);
    // 应用自己要求最大化（例如浏览器恢复上次的最大化会话）
    m2.maximize(Meta.MaximizeFlags.BOTH);
    // 等「几何复核 → 布局迁就 lim1 的 600 高」走完（复核梯级最长 2s）
    await sleep(1600);
    const maxLayout = manager.store.get(freshWorkspace, 0);
    maxLayout.tree.layout(AREA);
    check('需求6 · 新窗口自带的最大化被取消，改为平铺',
        m2.get_maximize_flags() === 0 && !maxLayout.maximized && !maxLayout.paused &&
        !m2.minimized && sameRect(m2.get_frame_rect(), maxLayout.tree.rectFor(m2)),
        `flags=${m2.get_maximize_flags()} layout.maximized=${maxLayout.maximized ? 'set' : 'null'} ` +
        `paused=${maxLayout.paused} ${fmt(m2.get_frame_rect())} ` +
        `期望 ${fmt(maxLayout.tree.rectFor(m2))}`);
    checkNoGaps('需求6 补充', [m1, m2]);
    checkNoOverlap('需求6 补充', [m1, m2]);

    /* ---------------- 尺寸限制：其它窗口迁就受限的窗口 ---------------- */
    // m1 带着客户端最小高度（600）参与平铺，和 m2 上下两行
    m1.unminimize();
    await settle();
    manager.retileAll();
    await settle();
    maxLayout.tree.layout(AREA);
    const m1Setup = maxLayout.tree.rectFor(m1);
    const m2Setup = maxLayout.tree.rectFor(m2);
    check('尺寸限制 · 准备：上下两行',
        maxLayout.tree.windows().length === 2 &&
        m1Setup && m2Setup &&
        (m1Setup.y === m2Setup.y + m2Setup.height || m2Setup.y === m1Setup.y + m1Setup.height),
        `${fmt(m1Setup)} / ${fmt(m2Setup)}`);

    manager.retileAll();
    await sleep(1600);   // 等几何核对与「迁就它」的改写布局
    maxLayout.tree.layout(AREA);
    const m1Rect = maxLayout.tree.rectFor(m1);
    const m2Rect = maxLayout.tree.rectFor(m2);
    check('尺寸限制 · 受限窗口保住自己的尺寸',
        m1.get_frame_rect().height >= 600 && sameRect(m1.get_frame_rect(), m1Rect),
        `${fmt(m1.get_frame_rect())} 布局 ${fmt(m1Rect)}`);
    const stacked = m1Rect.y < m2Rect.y
        ? m1Rect.y + m1Rect.height === m2Rect.y
        : m2Rect.y + m2Rect.height === m1Rect.y;
    check('尺寸限制 · 相邻窗口迁就它（分界线被改写）',
        m1Rect.height === 600 && stacked && m2Rect.height === AREA.height - 600,
        `m1=${fmt(m1Rect)} m2=${fmt(m2Rect)}`);
    checkNoGaps('尺寸限制', [m1, m2]);
    checkNoOverlap('尺寸限制', [m1, m2]);

    /* ---------------- 对话框：既不参与平铺、也不受重叠约束 ---------------- */
    const dialog = display.createDialog('dlg', m2, freshWorkspace);
    await settle();
    check('对话框 · 不进入平铺布局',
        maxLayout.tree.findLeaf(dialog) === null &&
        !maxLayout.tree.windows().includes(dialog) && !dialog.minimized,
        `在布局里=${maxLayout.tree.findLeaf(dialog) !== null}`);
    check('对话框 · 保持 mutter 给的位置（扩展不动它）',
        sameRect(dialog.get_frame_rect(), {x: 420, y: 260, width: 640, height: 400}),
        fmt(dialog.get_frame_rect()));
    check('对话框 · 平铺窗口仍然铺满工作区（不被对话框挤开）',
        (() => {
            const sum = [m1, m2].filter(w => !w.minimized)
                .reduce((total, w) => {
                    const r = w.get_frame_rect();
                    return total + r.width * r.height;
                }, 0);
            return sum === AREA.width * AREA.height;
        })(),
        [m1, m2].map(w => `${w.title}${fmt(w.get_frame_rect())}`).join(' '));
    checkNoGaps('对话框存在时', [m1, m2]);
    checkNoOverlap('对话框存在时（平铺窗口之间）', [m1, m2]);

    /* 文件选择器这类窗口：先以普通窗口出现，过一会儿才「变成」对话框/附属窗口 */
    const late = display.createWindow('late', freshWorkspace);
    await settle();
    maxLayout.tree.layout(AREA);
    check('迟到对话框 · 准备：它一开始是参与平铺的',
        maxLayout.tree.findLeaf(late) !== null, `在布局里=${maxLayout.tree.findLeaf(late) !== null}`);

    // (1) 窗口类型后来变成 DIALOG（有通知可听）
    late._windowType = Meta.WindowType.DIALOG;
    late.emit('notify::window-type');
    await settle();
    check('迟到对话框 · 类型变成 DIALOG 后退出平铺',
        maxLayout.tree.findLeaf(late) === null && !late.minimized,
        `在布局里=${maxLayout.tree.findLeaf(late) !== null}`);
    // 退出平铺后剩下的行高会重新均分；m1 有客户端最小高度（600），
    // 均分会被它撑回来 —— 等几何复核 / 迁就走完再看
    await sleep(1800);
    checkNoGaps('迟到对话框退出后', maxLayout.tree.windows());

    // (2) 只是默默接上了父窗口，没有任何属性变化可听 → 靠兜底复核发现
    const late2 = display.createWindow('late2', freshWorkspace);
    await settle();
    maxLayout.tree.layout(AREA);
    check('迟到对话框 · 准备：第二个窗口也在平铺里',
        maxLayout.tree.findLeaf(late2) !== null, `在布局里=${maxLayout.tree.findLeaf(late2) !== null}`);
    late2._transientFor = late;   // 父窗口关系后来才建立，而且不发任何通知
    await sleep(2600);            // 等兜底复核（每 2 秒一次）
    maxLayout.tree.layout(AREA);
    check('迟到对话框 · 事后接上父窗口（无通知）也会退出平铺',
        maxLayout.tree.findLeaf(late2) === null && !late2.minimized,
        `在布局里=${maxLayout.tree.findLeaf(late2) !== null}`);
    check('迟到对话框全部退出后 · 被它顶替的父窗口回到布局，没有窗口被留在最小化状态',
        maxLayout.tree.findLeaf(late) === null && maxLayout.tree.findLeaf(late2) === null &&
        maxLayout.minimized.size === 0,
        `windows=${maxLayout.tree.windows().length} minimized=${maxLayout.minimized.size}`);

    const modal = display.createModalWindow('modal', freshWorkspace);
    await settle();
    check('附加模态窗口 · 不进入平铺布局',
        maxLayout.tree.findLeaf(modal) === null && !modal.minimized,
        `在布局里=${maxLayout.tree.findLeaf(modal) !== null}`);
    check('附加模态窗口 · 保持 mutter 给的位置（扩展不动它）',
        sameRect(modal.get_frame_rect(), {x: 420, y: 260, width: 640, height: 400}),
        fmt(modal.get_frame_rect()));

    /* ---------------- 最小化后还原 → 从左下开始平铺 ---------------- */
    const spotWorkspace = 7;
    display.workspace(spotWorkspace);
    const s1 = display.createWindow('s1', spotWorkspace);
    await settle();
    const s2 = display.createWindow('s2', spotWorkspace);
    await settle();
    manager.dropAt(s2, 4, 40);              // 拖到 s1 左边 → 左右两个「分栏」
    await settle();
    const spotLayout = manager.store.get(spotWorkspace, 0);
    spotLayout.tree.layout(AREA);
    const s1Before = spotLayout.tree.rectFor(s1);
    const s2Before = spotLayout.tree.rectFor(s2);
    check('准备 · 两个窗口左右并排（分栏）',
        !!s1Before && !!s2Before && !s1.minimized && !s2.minimized &&
        s1Before.y === AREA.y && s1Before.height === AREA.height &&
        s2Before.y === AREA.y && s2Before.height === AREA.height &&
        (s1Before.x + s1Before.width === s2Before.x ||
         s2Before.x + s2Before.width === s1Before.x),
        `${fmt(s1Before)} / ${fmt(s2Before)}`);

    s1.minimize();     // 用户自己按下最小化
    await settle();
    check('最小化 · 兄弟窗口吸收它腾出的空间',
        sameRect(s2.get_frame_rect(), AREA), fmt(s2.get_frame_rect()));

    s1.unminimize();   // 再还原
    await settle();
    await sleep(200);
    spotLayout.tree.layout(AREA);
    const s1Restored = spotLayout.tree.rectFor(s1);
    const s2Restored = spotLayout.tree.rectFor(s2);
    check('还原 · 从左下开始平铺（和左下角那个窗口上下均分）',
        sameRect(s1.get_frame_rect(), s1Restored) &&
        sameRect(s2.get_frame_rect(), s2Restored) &&
        s1Restored && s2Restored &&
        s1Restored.y + s1Restored.height === AREA.y + AREA.height &&
        s2Restored.y === AREA.y &&
        s1Restored.height === s2Restored.height,
        `s1 ${fmt(s1.get_frame_rect())} 布局 ${fmt(s1Restored)}；` +
        `s2 ${fmt(s2.get_frame_rect())} 布局 ${fmt(s2Restored)}`);
    checkNoGaps('最小化还原', [s1, s2]);
    checkNoOverlap('最小化还原', [s1, s2]);

    /* ---------------- 需求 6 + 需求 2：关掉「最大化的下一个窗口」 ---------------- */
    const maxWorkspace = 6;
    display.workspace(maxWorkspace);
    const prev = display.createWindow('prev', maxWorkspace);
    await settle();
    prev.touchedByUser();
    prev.maximize(Meta.MaximizeFlags.BOTH);
    await settle();
    const next = display.createWindow('next', maxWorkspace);
    await settle();
    const positionLayout = manager.store.get(maxWorkspace, 0);
    check('需求6 · 打开新窗口时，原来最大化的窗口取消最大化、两个窗口都平铺',
        prev.get_maximize_flags() === 0 && !prev.minimized && !next.minimized &&
        positionLayout.maximized === null && !positionLayout.paused &&
        positionLayout.tree.windows().length === 2,
        `prev.flags=${prev.get_maximize_flags()} next.flags=${next.get_maximize_flags()} ` +
        `windows=${positionLayout.tree.windows().length}`);

    next.destroy();
    display.windows = display.windows.filter(w => w !== next);
    await settle();
    positionLayout.tree.layout(AREA);
    check('需求6 · 关掉新窗口 → 剩下的窗口吸收空间继续平铺',
        !prev.minimized && sameRect(prev.get_frame_rect(), AREA),
        `minimized=${prev.minimized} ${fmt(prev.get_frame_rect())}`);

    /* ---------------- 回归：取消最大化后必须铺满可用空间 ---------------- */
    const racyWorkspace = 5;
    display.workspace(racyWorkspace);
    const racy = display.createWindow('racy', racyWorkspace);
    await settle();
    racy.delayRestore = true;
    racy.touchedByUser();
    racy.maximize(Meta.MaximizeFlags.BOTH);
    await settle();
    // mutter 记着的「最大化前矩形」是一个旧的、没铺满的矩形（窗口在平铺之前就被最大化了）
    racy.simulateStaleMaximizeRect({x: 420, y: 260, width: 640, height: 400});
    racy.unmaximize(Meta.MaximizeFlags.BOTH);
    await sleep(900);   // 覆盖 120ms 的异步恢复 + 250ms 的兜底核对
    const racyLayout = manager.store.get(racyWorkspace, 0);
    racyLayout.tree.layout(AREA);
    check('取消最大化 · 窗口最终铺满自己的格子（不会被异步恢复的旧几何留下）',
        !racy.minimized && racy.get_maximize_flags() === 0 &&
        sameRect(racy.get_frame_rect(), racyLayout.tree.rectFor(racy)),
        `${fmt(racy.get_frame_rect())} 期望 ${fmt(racyLayout.tree.rectFor(racy))}`);

    /* ---------------- 需求 7：最大化 / 最小化的窗口挪过去保持状态 ---------------- */
    const relocA = 13;
    const relocB = 14;
    display.workspace(relocB);
    display.activateWorkspace(relocA);
    const relocBase = display.createWindow('relocBase', relocA);
    await settle();
    const relocMax = display.createWindow('relocMax', relocA);
    await settle();
    relocBase.unminimize();                 // 让 A 桌面有两个平铺窗口
    await settle();
    relocMax.touchedByUser();
    relocMax.maximize(Meta.MaximizeFlags.BOTH);
    await settle();
    display.activateWorkspace(relocB);
    const relocTarget = display.createWindow('relocTarget', relocB);
    await settle();

    const relocALayout = manager.store.get(display.workspace(relocA), 0);
    const relocBLayout = manager.store.get(display.workspace(relocB), 0);
    check('需求7 · 准备：A 桌面有最大化窗口、B 桌面有平铺窗口',
        relocALayout.maximized === relocMax && relocMax.get_maximize_flags() === Meta.MaximizeFlags.BOTH &&
        relocBLayout.tree.findLeaf(relocTarget) !== null,
        `A.maximized=${relocALayout.maximized?.title ?? 'null'} ` +
        `B.windows=${relocBLayout.tree.windows().length}`);

    // 最大化的窗口挪到 B：保持最大化，并接管 B 的最大化位置
    relocMax.moveToWorkspace(relocB);
    await settle();
    relocALayout.tree.layout(AREA);
    relocBLayout.tree.layout(AREA);
    check('需求7 · 最大化的窗口挪到别的桌面后仍然最大化',
        relocMax.get_maximize_flags() === Meta.MaximizeFlags.BOTH && !relocMax.minimized &&
        relocBLayout.maximized === relocMax && relocBLayout.paused === true,
        `flags=${relocMax.get_maximize_flags()} minimized=${relocMax.minimized} ` +
        `B.maximized=${relocBLayout.maximized?.title ?? 'null'}`);
    check('需求7 · 目标桌面的其它窗口照常（还在自己的格子里）',
        sameRect(relocTarget.get_frame_rect(), relocBLayout.tree.rectFor(relocTarget)),
        `${fmt(relocTarget.get_frame_rect())} 期望 ${fmt(relocBLayout.tree.rectFor(relocTarget))}`);
    check('需求7 · 原来的桌面照常（剩下的窗口吸收腾出的空间）',
        relocALayout.tree.findLeaf(relocMax) === null && relocALayout.maximized === null &&
        relocALayout.tree.findLeaf(relocBase) !== null &&
        sameRect(relocBase.get_frame_rect(), relocALayout.tree.rectFor(relocBase)),
        `A.windows=${relocALayout.tree.windows().length} ` +
        `A.maximized=${relocALayout.maximized?.title ?? 'null'}`);

    // 在 B 桌面上切到那个普通窗口：挪进来的最大化窗口应当取消最大化、并且重新参与平铺
    display.focus(relocTarget);
    await settle();
    relocBLayout.tree.layout(AREA);
    check('需求7 · 切走焦点时，挪进来的最大化窗口只取消自己的最大化',
        relocMax.get_maximize_flags() === 0 && relocBLayout.maximized === null &&
        !relocBLayout.paused,
        `flags=${relocMax.get_maximize_flags()} ` +
        `B.maximized=${relocBLayout.maximized?.title ?? 'null'} paused=${relocBLayout.paused}`);
    check('需求7 · 取消最大化之后它重新参与平铺（不再飘在外面）',
        relocBLayout.tree.findLeaf(relocMax) !== null && !relocMax.minimized &&
        sameRect(relocMax.get_frame_rect(), relocBLayout.tree.rectFor(relocMax)),
        `在布局里=${relocBLayout.tree.findLeaf(relocMax) !== null} ` +
        `${fmt(relocMax.get_frame_rect())} 期望 ${fmt(relocBLayout.tree.rectFor(relocMax))}`);
    checkNoGaps('需求7 · 挪进来的最大化窗口取消最大化之后', relocBLayout.tree.windows());
    checkNoOverlap('需求7 · 挪进来的最大化窗口取消最大化之后', relocBLayout.tree.windows());

    // 最小化的窗口挪到 B：保持最小化、不参与平铺
    relocBase.minimize();
    await settle();
    relocBase.moveToWorkspace(relocB);
    await settle();
    check('需求7 · 最小化的窗口挪到别的桌面后仍然最小化、不参与平铺',
        relocBase.minimized === true && relocBLayout.minimized.has(relocBase) &&
        relocBLayout.tree.findLeaf(relocBase) === null,
        `minimized=${relocBase.minimized} 在集合里=${relocBLayout.minimized.has(relocBase)} ` +
        `在布局里=${relocBLayout.tree.findLeaf(relocBase) !== null}`);

    /* ---------------- 全屏只是暂时状态：退出后要回到平铺 ---------------- */
    const fsWorkspace = 12;
    display.activateWorkspace(fsWorkspace);
    const fs1 = display.createWindow('fs1', fsWorkspace);
    await settle();
    const fs2 = display.createWindow('fs2', fsWorkspace);
    await settle();
    fs1.unminimize();
    await settle();
    const fsLayout = manager.store.get(display.workspace(fsWorkspace), 0);
    fsLayout.tree.layout(AREA);
    const fsCell = fsLayout.tree.rectFor(fs1);
    check('全屏 · 准备：窗口参与平铺', !!fsCell && fsLayout.tree.findLeaf(fs1) !== null,
        fmt(fsCell));

    fs1.setFullscreen(true);
    await sleep(2600);   // 覆盖一次兜底复核（每 2 秒一次）
    check('全屏 · 全屏期间不会被误判成「不该平铺」而驱逐',
        fsLayout.tree.findLeaf(fs1) !== null,
        `在布局里=${fsLayout.tree.findLeaf(fs1) !== null}`);

    fs1.setFullscreen(false);
    await settle();
    fsLayout.tree.layout(AREA);
    check('全屏 · 退出全屏后回到平铺（并且是原来那个格子）',
        fsLayout.tree.findLeaf(fs1) !== null && !fs1.minimized &&
        sameRect(fs1.get_frame_rect(), fsLayout.tree.rectFor(fs1)),
        `${fmt(fs1.get_frame_rect())} 期望 ${fmt(fsLayout.tree.rectFor(fs1))}`);
    checkNoGaps('全屏退出后', fsLayout.tree.windows());

    /* ---------------- 动态增删桌面：布局不能串位 ---------------- */
    const wsKeepA = 9;
    const wsEmpty = 10;
    const wsKeepB = 11;
    display.workspace(wsKeepB);          // 建到 11，中间的 10 空着
    display.activateWorkspace(wsKeepB);
    const keepA = display.createWindow('keepA', wsKeepA);
    await settle();
    const keepB = display.createWindow('keepB', wsKeepB);
    await settle();
    const layoutA = manager.store.get(display.workspace(wsKeepA), 0);
    const layoutB = manager.store.get(display.workspace(wsKeepB), 0);
    check('动态桌面 · 准备：两个桌面各有一份布局',
        !!layoutA && !!layoutB && layoutA !== layoutB &&
        layoutA.tree.windows().includes(keepA) &&
        layoutB.tree.windows().includes(keepB),
        `A=${layoutA?.tree.windows().length} B=${layoutB?.tree.windows().length}`);

    display.removeWorkspace(wsEmpty);    // 系统删掉中间空着的桌面
    await settle();
    const shifted = display.workspace(wsKeepB - 1);
    check('动态桌面 · 删掉空桌面后索引整体前移', shifted.index() === wsKeepB - 1,
        `index=${shifted.index()}`);
    check('动态桌面 · 布局仍然跟着原来的工作区，没有串位',
        manager.store.get(shifted, 0) === layoutB &&
        manager.store.get(display.workspace(wsKeepA), 0) === layoutA,
        `B 布局相同=${manager.store.get(shifted, 0) === layoutB}`);
    check('动态桌面 · 移位之后这个桌面依然正常平铺',
        sameRect(keepB.get_frame_rect(), layoutB.tree.rectFor(keepB)),
        `${fmt(keepB.get_frame_rect())} 期望 ${fmt(layoutB.tree.rectFor(keepB))}`);

    // 在移位后的桌面上再开一个窗口：它必须进「同一个」布局，而不是另起一份
    const keepC = display.createWindow('keepC', wsKeepB - 1);
    await settle();
    layoutB.tree.layout(AREA);
    check('动态桌面 · 移位后新开的窗口进的是同一份布局',
        layoutB.tree.findLeaf(keepC) !== null && manager.store.get(shifted, 0) === layoutB,
        `windows=${layoutB.tree.windows().length} 同一布局=${manager.store.get(shifted, 0) === layoutB}`);
    checkNoGaps('动态桌面 · 移位之后', layoutB.tree.windows());
    checkNoOverlap('动态桌面 · 移位之后', layoutB.tree.windows());

    /* ---------------- 拖动过程中不被自己的自动调整干扰 ---------------- */
    const dragWorkspace = 18;
    display.activateWorkspace(dragWorkspace);
    const dr1 = display.createWindow('dr1', dragWorkspace);
    await settle();
    const dr2 = display.createWindow('dr2', dragWorkspace);
    await settle();
    const dragLayout = manager.store.get(display.workspace(dragWorkspace), 0);
    dragLayout.tree.layout(AREA);
    const boundaryY = dragLayout.tree.rectFor(dr2).y;   // dr1 下边缘 = dr2 上边缘

    // (1) 抓住 dr2 的上边缘往上拖 200px：边界应当跟着指针走（不看客户端确认）
    display.pointer(0, boundaryY);
    manager.beginResize(dr2, ['n']);
    display.pointer(0, boundaryY - 200);
    await sleep(120);                                   // 让指针轮询跑几帧
    dragLayout.tree.layout(AREA);
    check('拖动中 · 边界跟着指针走（不等客户端确认）',
        dragLayout.tree.rectFor(dr1).height === boundaryY - 200,
        `dr1 高度=${dragLayout.tree.rectFor(dr1).height} 期望 ${boundaryY - 200}`);

    // (2) 拖动中：兜底扫查不该去碰正在拖动的窗口
    for (const window of [dr1, dr2])
        window.moves = 0;
    manager._verifyLater(dr2);      // 拖动前/拖动中排队的几何复核
    await sleep(700);
    check('拖动中 · 排队的几何复核不会去碰正在拖动的窗口', dr2.moves === 0,
        `dr2.moves=${dr2.moves}`);

    // (3) 拖过界（越过邻居的最小尺寸）：边界被钳制，松手后窗口落在真正的边界上
    display.pointer(0, AREA.height - 10);
    dr2.resizeTo({x: 0, y: AREA.height - 10, width: AREA.width, height: 10});
    await sleep(200);
    dragLayout.tree.layout(AREA);
    check('拖过界 · 拖动中不去和合成器抢（边界已钳制，窗口仍归指针）',
        dr2.moves === 0 && dragLayout.tree.rectFor(dr1).height >= 120,
        `dr2.moves=${dr2.moves} dr1 高度=${dragLayout.tree.rectFor(dr1).height}`);

    manager.endResize(dr2);
    await settle();
    dragLayout.tree.layout(AREA);
    check('拖动结束 · 松手后窗口落在真正的边界上（与布局一致）',
        sameRect(dr2.get_frame_rect(), dragLayout.tree.rectFor(dr2)) &&
        dragLayout.tree.rectFor(dr1).height >= 120,
        `${fmt(dr2.get_frame_rect())} 期望 ${fmt(dragLayout.tree.rectFor(dr2))}；` +
        `dr1 高度=${dragLayout.tree.rectFor(dr1).height}`);
    checkNoGaps('拖动结束', dragLayout.tree.windows());
    checkNoOverlap('拖动结束', dragLayout.tree.windows());

    /* ---------------- 稳定性：新窗口尽量一步到位、不做无谓的几何请求 ---------------- */
    const stepWorkspace = 16;
    display.activateWorkspace(stepWorkspace);
    const st1 = display.createWindow('st1', stepWorkspace);
    await settle();
    const st2 = display.createWindow('st2', stepWorkspace);
    await settle();
    const st3 = display.createWindow('st3', stepWorkspace);
    await settle();
    for (const window of [st1, st2, st3])
        window.moves = 0;

    // 什么都不会变的重新平铺：一个几何请求都不该发
    manager.retileAll();
    await sleep(500);
    check('稳定性 · 布局没变化时不发多余的几何请求',
        [st1, st2, st3].every(window => window.moves === 0),
        `moves=${[st1, st2, st3].map(window => window.moves).join('/')}`);

    // 新窗口：插入后这一栏行高均分，所以同一栏的窗口都会动 —— 但每个都只动一次
    // （一步到位，不会来回摆）
    const st4 = display.createWindow('st4', stepWorkspace);
    await settle();
    const moved = [st1, st2, st3].filter(window => (window.moves ?? 0) > 0);
    check('稳定性 · 新窗口一次到位，每个窗口最多只动一次',
        (st4.moves ?? 0) === 1 && moved.every(window => window.moves === 1) &&
        new Set(moved.map(window => window.moves)).size <= 1,
        `新窗口=${st4.moves} 其它=${[st1, st2, st3].map(window => `${window.title}:${window.moves}`).join(' ')}`);

    /* ---------------- 客户端尺寸限制：分界线跟着指针，之后布局迁就它 ---------------- */
    const limitWorkspace = 17;
    display.activateWorkspace(limitWorkspace);
    const lim1 = display.createWindow('lim1', limitWorkspace);
    lim1.minWidth = 700;   // 这个窗口不肯低于 700 宽（落位之前就声明）
    await settle();
    const lim2 = display.createWindow('lim2', limitWorkspace);
    await settle();
    manager.dropAt(lim2, 4, 40);          // 拖成左右两列
    await sleep(1600);                    // 等自动迁就（lim1 拒绝变窄）
    const limLayout = manager.store.get(display.workspace(limitWorkspace), 0);
    limLayout.tree.layout(AREA);
    const limitColumnWidth = () => {
        const rect = limLayout.tree.rectFor(lim1);
        return rect ? rect.width : 0;
    };
    check('尺寸限制 · 布局按客户端能做到的宽度迁就（≥700）',
        limitColumnWidth() >= 700, `lim1 列宽=${limitColumnWidth()}`);
    check('尺寸限制 · 相邻窗口让出了空间、就在自己的格子里',
        sameRect(lim2.get_frame_rect(), limLayout.tree.rectFor(lim2)),
        `${fmt(lim2.get_frame_rect())} 布局 ${fmt(limLayout.tree.rectFor(lim2))}`);

    // 手动把分界线往右拖 260px：lim1 声明了最小宽度 700，所以拖动过程中
    // 分界线就正好停在 lim1 能做到的最窄处 —— 不会先冲过去、松手再被拽回来
    const leftColumn = limLayout.tree.rectFor(lim2);
    if (leftColumn && limitColumnWidth() > 0) {
        const boundaryX = leftColumn.x + leftColumn.width;
        const targetX = boundaryX + 260;
        const middleY = Math.round(AREA.height / 2);
        display.pointer(boundaryX, middleY);
        manager.beginResize(lim2, ['e']);
        display.pointer(targetX, middleY);
        await sleep(120);                 // 让指针轮询跑几帧
        limLayout.tree.layout(AREA);
        check('手动调整 · 拖动中分界线跟着指针（不被邻居的尺寸钉住）',
            limLayout.tree.rectFor(lim2).width === targetX,
            `lim2 宽=${limLayout.tree.rectFor(lim2).width} 期望 ${targetX}`);

        manager.endResize(lim2);
        await sleep(1600);                // 复核 → 迁就 lim1 做不到更窄
        limLayout.tree.layout(AREA);
        check('手动调整 · 松手后布局迁就受限的窗口（≥700，且不重叠）',
            limitColumnWidth() >= 700 &&
            sameRect(lim1.get_frame_rect(), limLayout.tree.rectFor(lim1)),
            `lim1 列宽=${limitColumnWidth()} 实际 ${fmt(lim1.get_frame_rect())} ` +
            `布局 ${fmt(limLayout.tree.rectFor(lim1))}`);
        checkNoGaps('手动调整之后', limLayout.tree.windows());
        checkNoOverlap('手动调整之后', limLayout.tree.windows());
    } else {
        check('手动调整 · 拖动中分界线跟着指针（不被邻居的尺寸钉住）', false, 'lim2 不在布局里');
    }

    /*
     * 回归：分界线只跟着指针走，不会被「这个窗口曾经有多大」钉住。
     * 曾经的实现会「学着」把窗口某个瞬间的尺寸当成它的最小尺寸，于是 pin1
     * （第一个窗口，铺满过整屏 800 高）会把分界线顶在 800 上 —— 拖动时相邻窗口
     * 突然被压到最小尺寸、焦点窗口也不再跟着鼠标。
     */
    const pinWorkspace = 19;
    display.activateWorkspace(pinWorkspace);
    const pin1 = display.createWindow('pin1', pinWorkspace);
    await settle();
    const pin2 = display.createWindow('pin2', pinWorkspace);
    await settle();
    const pinLayout = manager.store.get(display.workspace(pinWorkspace), 0);
    pinLayout.tree.layout(AREA);
    display.pointer(0, pinLayout.tree.rectFor(pin2).y);
    manager.beginResize(pin2, ['n']);
    display.pointer(0, 100);              // 把分界线拖到 y=100（通用最小值 120 之上一点）
    await sleep(120);
    pinLayout.tree.layout(AREA);
    check('回归 · 分界线严格跟着指针（不理会窗口曾经的尺寸）',
        pinLayout.tree.rectFor(pin1).height === 120 &&
        pinLayout.tree.rectFor(pin2).y === 120 &&
        pinLayout.tree.rectFor(pin2).height === AREA.height - 120,
        `pin1 高=${pinLayout.tree.rectFor(pin1).height} pin2=${fmt(pinLayout.tree.rectFor(pin2))}`);
    manager.endResize(pin2);
    await settle();
    pinLayout.tree.layout(AREA);
    check('回归 · 松手后窗口落在分界线上（不弹回）',
        sameRect(pin2.get_frame_rect(), pinLayout.tree.rectFor(pin2)) &&
        sameRect(pin1.get_frame_rect(), pinLayout.tree.rectFor(pin1)),
        `pin1 ${fmt(pin1.get_frame_rect())} pin2 ${fmt(pin2.get_frame_rect())}`);
    checkNoGaps('回归', pinLayout.tree.windows());
    checkNoOverlap('回归', pinLayout.tree.windows());

    /*
     * 回归：抓取边缘时以**布局里的那条分界线**为基准，而不是窗口此刻的实际边缘。
     * 客户端没照做（尺寸限制）或几何还没生效时，实际边缘可能离格子边缘很远；
     * 拿它当基准，抓取的一瞬间分界线就会跳到别处 —— 连累到跟这条边无关的窗口，
     * 而且鼠标再动也是从一个错的位置开始跟。
     */
    const anchorWorkspace = 21;
    display.activateWorkspace(anchorWorkspace);
    const an1 = display.createWindow('an1', anchorWorkspace);
    await settle();
    const an2 = display.createWindow('an2', anchorWorkspace);
    await settle();
    manager.dropAt(an2, 4, 40);          // 左右两列（an2 在左）
    await settle();
    const anLayout = manager.store.get(display.workspace(anchorWorkspace), 0);
    anLayout.tree.layout(AREA);
    const anLeft = anLayout.tree.rectFor(an2);
    const anRightBefore = anLayout.tree.rectFor(an1);
    const middleY = Math.round(AREA.height / 2);

    // 让 an2 的**实际**几何比它在布局里的格子宽 260px（客户端不肯、或还没生效）
    const offBy = 260;
    an2.resizeTo({x: anLeft.x, y: anLeft.y, width: anLeft.width + offBy, height: anLeft.height});
    display.pointer(anLeft.x + anLeft.width + offBy, middleY);
    manager.beginResize(an2, ['e']);
    await sleep(80);                     // 让指针轮询跑几帧
    anLayout.tree.layout(AREA);
    check('回归 · 抓取瞬间不会因为实际尺寸不同就把分界线挪到别处',
        anLayout.tree.rectFor(an2).width === anLeft.width &&
        anLayout.tree.rectFor(an1).width === anRightBefore.width,
        `左列 ${anLayout.tree.rectFor(an2).width}（期望 ${anLeft.width}）、` +
        `右列 ${anLayout.tree.rectFor(an1).width}（期望 ${anRightBefore.width}）`);

    // 之后 1:1 跟着指针往右 100px：分界线往右 100，邻居让出 100
    display.pointer(anLeft.x + anLeft.width + offBy + 100, middleY);
    await sleep(120);
    anLayout.tree.layout(AREA);
    check('回归 · 抓取之后分界线 1:1 跟着指针（邻居按同样的量让出）',
        anLayout.tree.rectFor(an2).width === anLeft.width + 100 &&
        anLayout.tree.rectFor(an1).width === anRightBefore.width - 100,
        `左列 ${anLayout.tree.rectFor(an2).width}、右列 ${anLayout.tree.rectFor(an1).width}`);
    manager.endResize(an2);
    await sleep(200);
    checkNoGaps('回归（基准）', anLayout.tree.windows());
    checkNoOverlap('回归（基准）', anLayout.tree.windows());

    /*
     * 回归（左中右）：拖动某一栏的右边框时，**最外层那条分界线之外**的那一栏
     * 必须一点不动。布局里相邻的几栏整体是一棵子树，按比例改这棵子树会让里面的
     * 栏一起变 —— 那正是「意外调整了无关窗口」的来源。
     */
    const threeColWorkspace = 22;
    display.activateWorkspace(threeColWorkspace);
    const t1 = display.createWindow('t1', threeColWorkspace);
    await settle();
    const t2 = display.createWindow('t2', threeColWorkspace);
    await settle();
    manager.dropAt(t2, 4, 40);                    // t2 成为左边的分栏
    await settle();
    const t3 = display.createWindow('t3', threeColWorkspace);
    await settle();
    manager.dropAt(t3, 4, 40);                    // 再插一个分栏出来 → 三个分栏
    await settle();
    const colLayout2 = manager.store.get(display.workspace(threeColWorkspace), 0);
    colLayout2.tree.layout(AREA);
    const columns = colLayout2.tree.windows()
        .map(window => ({window, rect: colLayout2.tree.rectFor(window)}))
        .sort((a, b) => a.rect.x - b.rect.x);
    check('回归（三栏） · 准备：左中右三个分栏',
        columns.length === 3 && colLayout2.tree.columnCount() === 3 &&
        columns.every(column => column.rect.height === AREA.height) &&
        columns[0].rect.x === AREA.x &&
        columns[2].rect.x + columns[2].rect.width === AREA.width &&
        columns[1].rect.width >= 160,
        columns.map(column => `${column.window.title}${fmt(column.rect)}`).join(' '));

    if (columns.length === 3) {
        // 最外层（根节点）那条竖向分界线两侧相邻的两栏，以及再外面那一栏
        const outer = colLayout2.tree.boundaries().find(
            boundary => boundary.orientation === 'h' && boundary.split === colLayout2.tree.root);
        const dragColumn = outer?.before?.window ?? null;
        const adjacentColumn = outer?.after?.window ?? null;
        const farColumn = columns.map(column => column.window)
            .find(window => window !== dragColumn && window !== adjacentColumn) ?? null;
        const dragRect = dragColumn ? colLayout2.tree.rectFor(dragColumn) : null;

        if (dragColumn && adjacentColumn && farColumn && dragRect) {
            const step = 60;
            const midY = Math.round(AREA.height / 2);
            display.pointer(dragRect.x + dragRect.width, midY);
            manager.beginResize(dragColumn, ['e']);
            display.pointer(dragRect.x + dragRect.width + step, midY);
            await sleep(140);                   // 让指针轮询跑几帧
            colLayout2.tree.layout(AREA);
            check('回归（三栏） · 拖动一栏的右边框：这条边之外的那一栏一点不动',
                columns.some(column => column.window === farColumn &&
                    sameRect(colLayout2.tree.rectFor(farColumn), column.rect)),
                `${fmt(colLayout2.tree.rectFor(farColumn))} 期望 ${fmt(
                    columns.find(column => column.window === farColumn)?.rect)}`);
            check('回归（三栏） · 只有相邻的两栏变了（一边 +60、一边 -60）',
                colLayout2.tree.rectFor(dragColumn).width === dragRect.width + step &&
                colLayout2.tree.rectFor(adjacentColumn).width ===
                    columns.find(column => column.window === adjacentColumn).rect.width - step,
                `拖动栏 ${colLayout2.tree.rectFor(dragColumn).width}（期望 ${dragRect.width + step}）、` +
                `相邻栏 ${colLayout2.tree.rectFor(adjacentColumn).width}`);
            manager.endResize(dragColumn);
            await sleep(300);
            checkNoGaps('回归（三栏）', colLayout2.tree.windows());
            checkNoOverlap('回归（三栏）', colLayout2.tree.windows());
        } else {
            check('回归（三栏） · 拖动一栏的右边框：这条边之外的那一栏一点不动', false,
                `没找到最外层的竖向分界线（drag=${!!dragColumn} adjacent=${!!adjacentColumn}）`);
        }
    }

    /* 回归（上中下）：拖动中间那一行的上边框时，最下面那一行必须一点不动。 */
    const threeRowWorkspace = 23;
    display.activateWorkspace(threeRowWorkspace);
    const rw1 = display.createWindow('rw1', threeRowWorkspace);
    await settle();
    const rw2 = display.createWindow('rw2', threeRowWorkspace);
    await settle();
    const rw3 = display.createWindow('rw3', threeRowWorkspace);
    await settle();
    const rowLayout = manager.store.get(display.workspace(threeRowWorkspace), 0);
    rowLayout.tree.layout(AREA);
    const rows = rowLayout.tree.windows()
        .map(window => ({window, rect: rowLayout.tree.rectFor(window)}))
        .sort((a, b) => a.rect.y - b.rect.y);
    check('回归（三行） · 准备：上中下三行',
        rows.length === 3 && rows[2].rect.y + rows[2].rect.height === AREA.height &&
        rows[1].rect.height >= 120,
        rows.map(r => `${r.window.title}${fmt(r.rect)}`).join(' '));

    if (rows.length === 3) {
        const [topRow, midRow, bottomRow] = rows;
        const step = 60;
        const border = midRow.rect.y;
        const midX = Math.round(AREA.width / 2);
        display.pointer(midX, border);
        manager.beginResize(midRow.window, ['n']);
        display.pointer(midX, border - step);
        await sleep(140);
        rowLayout.tree.layout(AREA);
        check('回归（三行） · 拖动中间行的上边框：最下面那一行一点不动',
            sameRect(rowLayout.tree.rectFor(bottomRow.window), bottomRow.rect),
            `${fmt(rowLayout.tree.rectFor(bottomRow.window))} 期望 ${fmt(bottomRow.rect)}`);
        check('回归（三行） · 中间的变高、上面的让出同样多的高度',
            rowLayout.tree.rectFor(midRow.window).height === midRow.rect.height + step &&
            rowLayout.tree.rectFor(topRow.window).height === topRow.rect.height - step,
            `中 ${rowLayout.tree.rectFor(midRow.window).height}（期望 ${midRow.rect.height + step}）、` +
            `上 ${rowLayout.tree.rectFor(topRow.window).height}（期望 ${topRow.rect.height - step}）`);
        manager.endResize(midRow.window);
        await sleep(300);
        checkNoGaps('回归（三行）', rowLayout.tree.windows());
        checkNoOverlap('回归（三行）', rowLayout.tree.windows());
    }

    /*
     * 斜向调整：拖动窗口四角时同时调整宽度和高度（mutter 会同时给出两个方向）。
     * 要求稳定：两条边各自 1:1 跟着指针、互不打架，重复同一指针位置不会继续漂。
     */
    const cornerWorkspace = 27;
    display.activateWorkspace(cornerWorkspace);
    const cw1 = display.createWindow('cw1', cornerWorkspace);
    await settle();
    const cw2 = display.createWindow('cw2', cornerWorkspace);
    await settle();
    // cw2 拖成左边的分栏，再开 cw3（切在左下角）→ 左列 cw2 / cw3、右边 cw1
    manager.dropAt(cw2, 4, 40);
    await settle();
    const cw3 = display.createWindow('cw3', cornerWorkspace);
    await settle();
    const cwLayout = manager.store.get(display.workspace(cornerWorkspace), 0);
    cwLayout.tree.layout(AREA);
    const cwLeftTop = cwLayout.tree.rectFor(cw2);
    const cwBefore = new Map(cwLayout.tree.windows().map(w => [w, cwLayout.tree.rectFor(w)]));
    const cwHasBothEdges = cwLeftTop &&
        cwLeftTop.x + cwLeftTop.width < AREA.width &&
        cwLayout.tree.rectFor(cw3)?.y === cwLeftTop.y + cwLeftTop.height;
    check('斜向调整 · 准备：被拖动的窗口右边有列、下边有行', !!cwHasBothEdges,
        `cw2 ${fmt(cwLeftTop)} cw3 ${fmt(cwLayout.tree.rectFor(cw3))}`);
    if (cwHasBothEdges) {
        const startX = cwLeftTop.x + cwLeftTop.width;
        const startY = cwLeftTop.y + cwLeftTop.height;
        display.pointer(startX, startY);
        manager.beginResize(cw2, ['e', 's']);                    // 右下角
        display.pointer(startX + 80, startY + 40);               // 斜着拖
        await sleep(140);
        cwLayout.tree.layout(AREA);
        const cw2After = cwLayout.tree.rectFor(cw2);
        check('斜向调整 · 宽度和高度同时跟着指针走',
            cw2After.width === cwLeftTop.width + 80 &&
            cw2After.height === cwLeftTop.height + 40 &&
            cwLayout.tree.rectFor(cw3).height === cwBefore.get(cw3).height - 40 &&
            cwLayout.tree.rectFor(cw1).width === cwBefore.get(cw1).width - 80,
            `cw2 ${fmt(cw2After)}（期望宽+80 高+40） cw3 ${fmt(cwLayout.tree.rectFor(cw3))} ` +
            `cw1 ${fmt(cwLayout.tree.rectFor(cw1))}`);

        // 稳定性：同一个指针位置停着再轮询几帧，布局不应该继续漂
        const stable = fmt(cw2After);
        await sleep(160);
        cwLayout.tree.layout(AREA);
        check('斜向调整 · 指针不动时布局也不再变（稳定）',
            fmt(cwLayout.tree.rectFor(cw2)) === stable &&
            cwLayout.tree.rectFor(cw3).height === cwBefore.get(cw3).height - 40,
            `cw2 ${fmt(cwLayout.tree.rectFor(cw2))}（之前 ${stable}）`);

        // 继续斜着拖：两个方向同步推进
        display.pointer(startX + 120, startY + 60);
        await sleep(140);
        cwLayout.tree.layout(AREA);
        check('斜向调整 · 继续拖动时两个方向同步推进',
            cwLayout.tree.rectFor(cw2).width === cwLeftTop.width + 120 &&
            cwLayout.tree.rectFor(cw2).height === cwLeftTop.height + 60,
            `cw2 ${fmt(cwLayout.tree.rectFor(cw2))}`);

        manager.endResize(cw2);
        await sleep(300);
        cwLayout.tree.layout(AREA);
        check('斜向调整 · 松手后窗口仍然贴合格子（不跳）',
            sameRect(cw2.get_frame_rect(), cwLayout.tree.rectFor(cw2)),
            `${fmt(cw2.get_frame_rect())} 期望 ${fmt(cwLayout.tree.rectFor(cw2))}`);
        checkNoGaps('斜向调整', cwLayout.tree.windows());
        checkNoOverlap('斜向调整', cwLayout.tree.windows());
    }

    /*
     * 回归：分栏边界之外（更远的那一栏里的窗口）一点都不能动，两侧的宽度之和不变。
     */
    const farWorkspace = 28;
    display.activateWorkspace(farWorkspace);
    const f1 = display.createWindow('f1', farWorkspace);
    await settle();
    const f2 = display.createWindow('f2', farWorkspace);
    await settle();
    manager.dropAt(f2, 4, 40);                     // f2 | f1
    await settle();
    const f3 = display.createWindow('f3', farWorkspace);
    await settle();
    manager.dropAt(f3, 4, 40);                     // f3 | f2 | f1
    await settle();
    const farLayout = manager.store.get(display.workspace(farWorkspace), 0);
    farLayout.tree.layout(AREA);
    const farColumns = farLayout.tree.windows()
        .map(window => ({window, rect: farLayout.tree.rectFor(window)}))
        .sort((a, b) => a.rect.x - b.rect.x);
    const farBefore = new Map(farLayout.tree.windows().map(w => [w, farLayout.tree.rectFor(w)]));
    const firstBoundary = farColumns[0] ? farColumns[0].rect.x + farColumns[0].rect.width : 0;
    if (farColumns.length === 3 && firstBoundary > 0 && firstBoundary < AREA.width) {
        const step = 70;
        const midY = Math.round(AREA.height / 2);
        display.pointer(firstBoundary, midY);
        manager.beginResize(farColumns[0].window, ['e']);
        display.pointer(firstBoundary + step, midY);
        await sleep(140);
        farLayout.tree.layout(AREA);
        const farColumn = farColumns[2];
        check('回归（远处分栏） · 更远那一栏里的窗口一点不动',
            sameRect(farLayout.tree.rectFor(farColumn.window), farColumn.rect),
            `${fmt(farLayout.tree.rectFor(farColumn.window))} 期望 ${fmt(farColumn.rect)}`);
        check('回归（远处分栏） · 相邻两栏一侧 +、一侧 -，总宽度不变',
            farLayout.tree.rectFor(farColumns[0].window).width === farColumns[0].rect.width + step &&
            farLayout.tree.rectFor(farColumns[1].window).width === farColumns[1].rect.width - step &&
            farColumns[0].rect.width + farColumns[1].rect.width ===
                farLayout.tree.rectFor(farColumns[0].window).width +
                farLayout.tree.rectFor(farColumns[1].window).width,
            `第一栏 ${farLayout.tree.rectFor(farColumns[0].window).width}、` +
            `第二栏 ${farLayout.tree.rectFor(farColumns[1].window).width}`);
        manager.endResize(farColumns[0].window);
        await sleep(300);
        checkNoGaps('回归（远处分栏）', farLayout.tree.windows());
        checkNoOverlap('回归（远处分栏）', farLayout.tree.windows());
    }

    /* ---------------- 删除分栏时，其余分栏也等宽 ---------------- */
    const colWorkspace = 15;
    display.activateWorkspace(colWorkspace);
    const colA = display.createWindow('colA', colWorkspace);
    await settle();
    const colB = display.createWindow('colB', colWorkspace);
    await settle();
    // 用拖放做出三个分栏（插入时已经均分）
    manager.dropAt(colB, 4, 40);                    // colB 成为左边的分栏
    await settle();
    const colC = display.createWindow('colC', colWorkspace);
    await settle();
    manager.dropAt(colC, 4, 40);                    // 再插一个分栏出来
    await settle();
    const colLayout = manager.store.get(display.workspace(colWorkspace), 0);
    colLayout.tree.layout(AREA);
    const columnWindows = ['colA', 'colB', 'colC']
        .map(name => display.windows.find(window => window.title === name));
    const widths = () => columnWindows
        .filter(window => window && colLayout.tree.findLeaf(window))
        .map(window => colLayout.tree.rectFor(window).width);
    const three = widths();
    check('准备 · 三个分栏等宽',
        three.length === 3 && Math.max(...three) - Math.min(...three) <= 1 &&
        colLayout.tree.columnCount() === 3,
        `宽度=${three.join('/')} 列数=${colLayout.tree.columnCount()}`);

    // 手动拖宽其中一个分栏的右边缘（它得是列与列之间的边界，不能是屏幕边）
    const manualTarget = colLayout.tree.leaves()
        .map(leaf => leaf.window)
        .find(window => {
            const rect = colLayout.tree.rectFor(window);
            return rect && rect.x + rect.width < AREA.width;
        }) ?? colA;
    const manualRect = colLayout.tree.rectFor(manualTarget);
    manualTarget.resizeTo({
        x: manualRect.x, y: manualRect.y,
        width: 200, height: manualRect.height,
    });
    manager.commitResize(manualTarget, ['e']);
    await settle();
    colLayout.tree.layout(AREA);
    const manual = widths();
    check('准备 · 手动拖出不等宽的列',
        Math.max(...manual) - Math.min(...manual) > 1, `宽度=${manual.join('/')}`);

    // 关掉某一列里的一行：列数没变 → 宽度保持手动结果
    const rowInColumn = display.createWindow('colRow', colWorkspace);
    await settle();
    colLayout.tree.layout(AREA);
    const beforeRowClose = widths();
    rowInColumn.destroy();
    display.windows = display.windows.filter(w => w !== rowInColumn);
    await settle();
    colLayout.tree.layout(AREA);
    check('删除一列里的一行 · 列宽不变（不会抹掉手动拖出来的宽度）',
        colLayout.tree.columnCount() === 3 &&
        widths().join() === beforeRowClose.join(),
        `${beforeRowClose.join('/')} → ${widths().join('/')}`);

    // 关掉独占一列的那个窗口：列数变少 → 剩下的分栏重新均分
    const soloColumn = ['colA', 'colB', 'colC']
        .map(name => display.windows.find(w => w.title === name && !w.minimized))
        .find(window => window && colLayout.tree.leaves().some(leaf => leaf.window === window) &&
            colLayout.tree.columnRegion(colLayout.tree.findLeaf(window)) === colLayout.tree.findLeaf(window));
    if (soloColumn) {
        soloColumn.destroy();
        display.windows = display.windows.filter(w => w !== soloColumn);
        await settle();
        colLayout.tree.layout(AREA);
        const left = widths();
        check('删除分栏 · 剩下的分栏重新均分',
            colLayout.tree.columnCount() === 2 &&
            Math.max(...left) - Math.min(...left) <= 1,
            `宽度=${left.join('/')} 列数=${colLayout.tree.columnCount()}`);
        checkNoGaps('删除分栏之后', colLayout.tree.windows());
    } else {
        check('删除分栏 · 剩下的分栏重新均分', false, '没有找到独占一列的窗口');
    }

    /* ---------------- 可选：没有非最小化窗口时进入概览 ---------------- */
    const Main = await import('resource:///org/gnome/shell/ui/main.js');
    const overviewWorkspace = 8;
    display.activateWorkspace(overviewWorkspace);
    Main.overview.hide();
    const ov1 = display.createWindow('ov1', overviewWorkspace);
    await settle();
    check('概览 · 默认关闭',
        settings.get_default_value('show-overview-when-empty').get_boolean() === false,
        `默认值=${settings.get_default_value('show-overview-when-empty').get_boolean()}`);
    Main.overview.hide();
    ov1.minimize();
    await settle();
    check('概览 · 默认（关闭）时不会自动进入',
        Main.overview.visible === false, `visible=${Main.overview.visible}`);

    Main.overview.hide();
    ov1.unminimize();
    settings.set_boolean('show-overview-when-empty', true);
    await settle();
    check('概览 · 打开该选项、桌面上还有非最小化窗口时不进入',
        Main.overview.visible === false, `visible=${Main.overview.visible}`);

    ov1.minimize();
    await settle();
    check('概览 · 打开该选项后，没有非最小化窗口时自动进入概览',
        Main.overview.visible === true, `visible=${Main.overview.visible}`);

    Main.overview.hide();
    ov1.unminimize();
    await settle();
    settings.reset('show-overview-when-empty');

    /*
     * 概览（应用网格）里的操作：概览开着的时候不动窗口几何（会和动画抢），
     * 但动作要**延后**到概览关掉再做 —— 从概览里开新窗口、把窗口拖到别的桌面、
     * 在概览里切换窗口全都发生在这一刻，丢掉就会出现「新窗口不参与平铺」
     * 「挪过来的窗口进不了布局」「切走之后最大化窗口还最大化着」。
     */
    const ovWorkspace = 24;
    display.activateWorkspace(ovWorkspace);
    const ovA = display.createWindow('ovA', ovWorkspace);
    await settle();

    Main.overview.show();
    const ovB = display.createWindow('ovB', ovWorkspace);
    await settle();
    check('概览 · 打开期间先不动窗口几何（不和动画抢）',
        !sameRect(ovB.get_frame_rect(), AREA), fmt(ovB.get_frame_rect()));
    Main.overview.hide();
    await settle();
    const ovLayout = manager.store.get(display.workspace(ovWorkspace), 0);
    ovLayout.tree.layout(AREA);
    check('概览 · 关掉概览后新窗口补上了平铺',
        ovLayout.tree.findLeaf(ovB) !== null &&
        sameRect(ovB.get_frame_rect(), ovLayout.tree.rectFor(ovB)) &&
        sameRect(ovA.get_frame_rect(), ovLayout.tree.rectFor(ovA)),
        `ovB ${fmt(ovB.get_frame_rect())} 期望 ${fmt(ovLayout.tree.rectFor(ovB))}`);
    checkNoGaps('概览', ovLayout.tree.windows());
    checkNoOverlap('概览', ovLayout.tree.windows());

    // 在概览里把窗口拖到另一个桌面
    const ovOtherWorkspace = ovWorkspace + 1;
    display.workspace(ovOtherWorkspace);
    Main.overview.show();
    ovB.moveToWorkspace(ovOtherWorkspace);
    await settle();
    Main.overview.hide();
    await settle();
    const ovOtherLayout = manager.store.get(display.workspace(ovOtherWorkspace), 0);
    ovOtherLayout?.tree.layout(AREA);
    check('概览 · 关掉概览后，拖到别的桌面的窗口加入了那边的平铺',
        !!ovOtherLayout && ovOtherLayout.tree.findLeaf(ovB) !== null &&
        sameRect(ovB.get_frame_rect(), AREA),
        `${fmt(ovB.get_frame_rect())} 布局窗口数=${ovOtherLayout?.tree.windows().length}`);
    ovLayout.tree.layout(AREA);
    check('概览 · 原桌面剩下的窗口重新铺满',
        sameRect(ovA.get_frame_rect(), AREA), fmt(ovA.get_frame_rect()));

    // 在概览里从一个最大化窗口切走
    const ovMaxWorkspace = ovOtherWorkspace;
    display.activateWorkspace(ovMaxWorkspace);
    await settle();
    const ovC = display.createWindow('ovC', ovMaxWorkspace);
    await settle();
    ovC.touchedByUser();
    ovC.maximize(Meta.MaximizeFlags.BOTH);
    await settle();
    Main.overview.show();
    display.focus(ovB);
    await settle();
    check('概览 · 打开期间先不动最大化状态（不和动画抢）',
        ovC.get_maximize_flags() !== 0, `flags=${ovC.get_maximize_flags()}`);
    Main.overview.hide();
    await settle();
    const ovMaxLayout = manager.store.get(display.workspace(ovMaxWorkspace), 0);
    ovMaxLayout.tree.layout(AREA);
    check('概览 · 关掉概览后，原来最大化的窗口取消最大化并回到布局里',
        ovC.get_maximize_flags() === 0 && ovMaxLayout.maximized === null &&
        ovMaxLayout.tree.findLeaf(ovC) !== null &&
        sameRect(ovC.get_frame_rect(), ovMaxLayout.tree.rectFor(ovC)),
        `flags=${ovC.get_maximize_flags()} ${fmt(ovC.get_frame_rect())} ` +
        `期望 ${fmt(ovMaxLayout.tree.rectFor(ovC))}`);
    checkNoGaps('概览（最大化切走）', ovMaxLayout.tree.windows());

    /*
     * 回归（全屏）：退出全屏的那一瞬间，mutter 还可能认为窗口「跟屏幕一样大」。
     * 不能因为这一次复核就把它驱逐出平铺 —— 驱逐之后它就再也不参与平铺了。
     */
    const fs2Workspace = 29;
    display.activateWorkspace(fs2Workspace);
    const fx1 = display.createWindow('fx1', fs2Workspace);
    await settle();
    const fx2 = display.createWindow('fx2', fs2Workspace);
    await settle();
    const fxLayout = manager.store.get(display.workspace(fs2Workspace), 0);
    fx1.setFullscreen(true);
    await sleep(300);
    fx1.setFullscreen(false);
    await settle();                           // 先让「退出全屏」的延迟处理跑完
    fx1._monitorSized = true;                 // 几何还没缩回来
    manager._reevaluateWindow(fx1);           // 兜底复核（真机上每 2 秒一次）
    manager._reevaluateWindow(fx1);
    fx1._monitorSized = false;
    await settle();
    fxLayout.tree.layout(AREA);
    check('回归（全屏） · 退出全屏瞬间「跟屏幕一样大」也不会被驱逐出平铺',
        fxLayout.tree.findLeaf(fx1) !== null &&
        sameRect(fx1.get_frame_rect(), fxLayout.tree.rectFor(fx1)),
        `在布局里=${fxLayout.tree.findLeaf(fx1) !== null} ${fmt(fx1.get_frame_rect())} ` +
        `期望 ${fmt(fxLayout.tree.rectFor(fx1))}`);
    checkNoGaps('回归（全屏退出）', fxLayout.tree.windows());

    // 被摘出平铺的窗口（例如旧版本里被误判过的）：条件恢复后要能自动接管回来
    fx2._skipTaskbar = true;
    manager._reevaluateWindow(fx2);
    const fx2Evicted = fxLayout.tree.findLeaf(fx2) === null;
    fx2._skipTaskbar = false;
    manager._recheckEvicted();
    await settle();
    fxLayout.tree.layout(AREA);
    check('回归（全屏） · 被摘出平铺的窗口条件恢复后能自动回到平铺',
        fx2Evicted && fxLayout.tree.findLeaf(fx2) !== null &&
        sameRect(fx2.get_frame_rect(), fxLayout.tree.rectFor(fx2)),
        `先摘掉=${fx2Evicted} 回来了=${fxLayout.tree.findLeaf(fx2) !== null} ` +
        `${fmt(fx2.get_frame_rect())} 期望 ${fmt(fxLayout.tree.rectFor(fx2))}`);
    checkNoGaps('回归（全屏重新接管）', fxLayout.tree.windows());
    checkNoOverlap('回归（全屏重新接管）', fxLayout.tree.windows());

    /*
     * 回归（客户端最小宽度）：左中右三栏，把左边那栏拉大直到中间那栏碰到客户端
     * 最小宽度。迁就时应该由**刚才被拉大的左边**让回空间，右边那栏一点不动。
     */
    const minColWorkspace = 30;
    display.activateWorkspace(minColWorkspace);
    const nc1 = display.createWindow('nc1', minColWorkspace);
    await settle();
    const nc2 = display.createWindow('nc2', minColWorkspace);
    await settle();
    manager.dropAt(nc2, 4, 40);                     // nc2 成为左边的分栏
    await settle();
    const nc3 = display.createWindow('nc3', minColWorkspace);
    await settle();
    manager.dropAt(nc3, 4, 40);                     // 再插一个分栏 → 三栏
    await settle();
    const ncLayout = manager.store.get(display.workspace(minColWorkspace), 0);
    ncLayout.tree.layout(AREA);
    const ncColumns = ncLayout.tree.windows()
        .map(window => ({window, rect: ncLayout.tree.rectFor(window)}))
        .sort((a, b) => a.rect.x - b.rect.x);
    if (ncColumns.length === 3) {
        const [leftCol, midCol, rightCol] = ncColumns;
        const midMin = Math.max(160, midCol.rect.width - 100);   // 客户端不肯比这更窄
        midCol.window.minWidth = midMin;
        const rightBefore = rightCol.rect;
        const pairBefore = leftCol.rect.width + midCol.rect.width;
        const midY = Math.round(AREA.height / 2);
        const border = leftCol.rect.x + leftCol.rect.width;
        display.pointer(border, midY);
        manager.beginResize(leftCol.window, ['e']);
        display.pointer(border + 200, midY);        // 拉大左边 → 中间被压到最小以下
        await sleep(160);
        manager.endResize(leftCol.window);
        await sleep(1900);                          // 等复核 → 迁就客户端最小宽度
        ncLayout.tree.layout(AREA);
        check('回归（客户端最小宽度） · 由刚才拉大的左边让回空间，右边那栏一点不动',
            sameRect(ncLayout.tree.rectFor(rightCol.window), rightBefore) &&
            ncLayout.tree.rectFor(midCol.window).width >= midMin &&
            sameRect(midCol.window.get_frame_rect(), ncLayout.tree.rectFor(midCol.window)),
            `右栏 ${fmt(ncLayout.tree.rectFor(rightCol.window))} 期望 ${fmt(rightBefore)}；` +
            `中栏 ${fmt(ncLayout.tree.rectFor(midCol.window))} 实际 ${fmt(midCol.window.get_frame_rect())}`);
        check('回归（客户端最小宽度） · 相邻两栏的总宽度不变',
            ncLayout.tree.rectFor(leftCol.window).width +
                ncLayout.tree.rectFor(midCol.window).width === pairBefore,
            `左+中 ${ncLayout.tree.rectFor(leftCol.window).width + ncLayout.tree.rectFor(midCol.window).width} ` +
            `期望 ${pairBefore}`);
        checkNoGaps('回归（客户端最小宽度）', ncLayout.tree.windows());
        checkNoOverlap('回归（客户端最小宽度）', ncLayout.tree.windows());
    }

    /*
     * 回归（客户端最小高度）：上中下三行，拉大上面那行直到中间那行碰到客户端
     * 最小高度 —— 迁就时应该由刚才被拉大的上面让回空间，最下面那行一点不动。
     */
    const minRowWorkspace = 31;
    display.activateWorkspace(minRowWorkspace);
    const nr1 = display.createWindow('nr1', minRowWorkspace);
    await settle();
    const nr2 = display.createWindow('nr2', minRowWorkspace);
    await settle();
    const nr3 = display.createWindow('nr3', minRowWorkspace);
    await settle();
    const nrLayout = manager.store.get(display.workspace(minRowWorkspace), 0);
    nrLayout.tree.layout(AREA);
    const nrRows = nrLayout.tree.windows()
        .map(window => ({window, rect: nrLayout.tree.rectFor(window)}))
        .sort((a, b) => a.rect.y - b.rect.y);
    check('回归（三行最小高度） · 准备：上中下三行', nrRows.length === 3,
        nrRows.map(row => `${row.window.title}${fmt(row.rect)}`).join(' '));
    if (nrRows.length === 3) {
        const [topRow, midRow, bottomRow] = nrRows;
        const midMin = Math.max(140, midRow.rect.height - 40);   // 客户端不肯比这更矮
        midRow.window.minHeight = midMin;
        const bottomBefore = bottomRow.rect;
        const pairBefore = topRow.rect.height + midRow.rect.height;
        const minUnit = settings.get_int('minimum-window-size');
        // 拖过「中间那行到通用最小值」之后再多拖 40px → 下面那行必须接着让位
        const dragAmount = (midRow.rect.height - minUnit) + 40;
        const midX = Math.round(AREA.width / 2);
        const border = topRow.rect.y + topRow.rect.height;
        display.pointer(midX, border);
        manager.beginResize(topRow.window, ['s']);
        display.pointer(midX, border + dragAmount);
        await sleep(160);
        manager.endResize(topRow.window);
        await sleep(1900);                          // 等复核 → 迁就客户端最小高度
        nrLayout.tree.layout(AREA);
        // 拖过头时，中间那行先顶到「通用最小值」，剩下的位移由下面那行接着让
        // （「邻近的邻近窗口接着调整」）；随后客户端最小高度高于通用最小值，
        // 迁就时由刚才被拖大的上面让回空间。
        const cascade = 40;
        check('回归（客户端最小高度） · 中间行保住客户端最小高度，由上面让回空间',
            nrLayout.tree.rectFor(midRow.window).height >= midMin &&
            sameRect(midRow.window.get_frame_rect(), nrLayout.tree.rectFor(midRow.window)),
            `中行 ${fmt(nrLayout.tree.rectFor(midRow.window))} 实际 ${fmt(midRow.window.get_frame_rect())}`);
        check('回归（客户端最小高度） · 拖过通用最小值之后，下面那行接着让位（级联）',
            nrLayout.tree.rectFor(bottomRow.window).height === bottomBefore.height - cascade,
            `下行 ${fmt(nrLayout.tree.rectFor(bottomRow.window))} 期望高 ${bottomBefore.height - cascade}；` +
            `pairBefore=${pairBefore}`);
        checkNoGaps('回归（客户端最小高度）', nrLayout.tree.windows());
        checkNoOverlap('回归（客户端最小高度）', nrLayout.tree.windows());
    }

    /*
     * 同上，但抓的是**中间窗口自己的上边框**（实际拖拽时更常见的抓法）：
     * 往下一拖，中间窗口被压小，客户端拒绝；迁就时同样只能动这条边所在的
     * 上 / 中分界线，不能连累最下面那行。
     */
    const midDragWorkspace = 32;
    display.activateWorkspace(midDragWorkspace);
    const md1 = display.createWindow('md1', midDragWorkspace);
    await settle();
    const md2 = display.createWindow('md2', midDragWorkspace);
    await settle();
    const md3 = display.createWindow('md3', midDragWorkspace);
    await settle();
    const mdLayout = manager.store.get(display.workspace(midDragWorkspace), 0);
    mdLayout.tree.layout(AREA);
    const mdRows = mdLayout.tree.windows()
        .map(window => ({window, rect: mdLayout.tree.rectFor(window)}))
        .sort((a, b) => a.rect.y - b.rect.y);
    if (mdRows.length === 3) {
        const [mdTop, mdMid, mdBottom] = mdRows;
        mdMid.window.minHeight = mdMid.rect.height;     // 一丁点也不肯变矮
        const bottomBefore = mdBottom.rect;
        const topBefore = mdTop.rect;
        const midX = Math.round(AREA.width / 2);
        display.pointer(midX, mdMid.rect.y);
        manager.beginResize(mdMid.window, ['n']);
        display.pointer(midX, mdMid.rect.y + 90);       // 抓住中间窗口上边框往下拖
        await sleep(160);
        manager.endResize(mdMid.window);
        await sleep(1900);
        mdLayout.tree.layout(AREA);
        check('回归（抓中间行上边框） · 最下面那行一点不动，上面那行原地不动',
            sameRect(mdLayout.tree.rectFor(mdBottom.window), bottomBefore) &&
            sameRect(mdLayout.tree.rectFor(mdTop.window), topBefore) &&
            sameRect(mdLayout.tree.rectFor(mdMid.window), mdMid.rect),
            `上 ${fmt(mdLayout.tree.rectFor(mdTop.window))} 中 ${fmt(mdLayout.tree.rectFor(mdMid.window))} ` +
            `下 ${fmt(mdLayout.tree.rectFor(mdBottom.window))}`);
        checkNoGaps('回归（抓中间行上边框）', mdLayout.tree.windows());
        checkNoOverlap('回归（抓中间行上边框）', mdLayout.tree.windows());
    }

    /*
     * 预留：最小化窗口 ↔ 平铺窗口 的状态交换。
     * 概览里的拖拽目前接不到，但语义、账本和布局变换先准备好（swapWindowStates）。
     */
    const swapWorkspace = 33;
    display.activateWorkspace(swapWorkspace);
    const sw1 = display.createWindow('sw1', swapWorkspace);
    await settle();
    const sw2 = display.createWindow('sw2', swapWorkspace);
    await settle();
    const swLayout = manager.store.get(display.workspace(swapWorkspace), 0);
    swLayout.tree.layout(AREA);
    sw2.minimize();
    await settle();
    check('预留（状态交换） · 准备：一个平铺、一个最小化',
        !sw1.minimized && sw2.minimized &&
        swLayout.tree.findLeaf(sw2) === null && swLayout.tree.findLeaf(sw1) !== null &&
        swLayout.minimized.has(sw2),
        `sw1.minimized=${sw1.minimized} sw2.minimized=${sw2.minimized}`);
    check('预留（状态交换） · 交换成功', manager.swapWindowStates(sw2, sw1) === true);
    await settle();
    swLayout.tree.layout(AREA);
    check('预留（状态交换） · 最小化的那个占住对方的格子并恢复显示',
        !sw2.minimized && swLayout.tree.findLeaf(sw2) !== null &&
        !swLayout.minimized.has(sw2) &&
        sameRect(sw2.get_frame_rect(), swLayout.tree.rectFor(sw2)),
        `${fmt(sw2.get_frame_rect())} 期望 ${fmt(swLayout.tree.rectFor(sw2))}`);
    check('预留（状态交换） · 原来的平铺窗口被最小化、退出布局',
        sw1.minimized && swLayout.tree.findLeaf(sw1) === null &&
        swLayout.minimized.has(sw1),
        `sw1.minimized=${sw1.minimized}`);
    checkNoGaps('预留（状态交换）', swLayout.tree.windows());
    checkNoOverlap('预留（状态交换）', swLayout.tree.windows());
    // 被最小化的那个照常可以恢复回来，并且重新平铺
    sw1.unminimize();
    await settle();
    swLayout.tree.layout(AREA);
    check('预留（状态交换） · 被最小化的那个恢复后重新参与平铺',
        !sw1.minimized && swLayout.tree.findLeaf(sw1) !== null &&
        sameRect(sw1.get_frame_rect(), swLayout.tree.rectFor(sw1)),
        `${fmt(sw1.get_frame_rect())} 期望 ${fmt(swLayout.tree.rectFor(sw1))}`);
    checkNoGaps('预留（状态交换之后恢复）', swLayout.tree.windows());
    checkNoOverlap('预留（状态交换之后恢复）', swLayout.tree.windows());
    check('预留（状态交换） · 两个都平铺时不交换',
        manager.swapWindowStates(sw1, sw2) === false &&
        manager.swapWindowStates(sw2, sw1) === false,
        '必须一个最小化、一个平铺');

    /*
     * 级联：把左边那栏拉大，中间那栏到了最小尺寸之后，右边那栏接着让位。
     */
    const cascadeWorkspace = 37;
    display.activateWorkspace(cascadeWorkspace);
    const cs1 = display.createWindow('cs1', cascadeWorkspace);
    await settle();
    const cs2 = display.createWindow('cs2', cascadeWorkspace);
    await settle();
    manager.dropAt(cs2, 4, 40);
    await settle();
    const cs3 = display.createWindow('cs3', cascadeWorkspace);
    await settle();
    manager.dropAt(cs3, 4, 40);
    await settle();
    const csLayout = manager.store.get(display.workspace(cascadeWorkspace), 0);
    csLayout.tree.layout(AREA);
    const csCols = csLayout.tree.windows()
        .map(window => ({window, rect: csLayout.tree.rectFor(window)}))
        .sort((a, b) => a.rect.x - b.rect.x);
    if (csCols.length === 3) {
        const [csLeft, csMid, csRight] = csCols;
        const minUnit = settings.get_int('minimum-window-size');
        const overflow = 70;
        const drag = (csMid.rect.width - minUnit) + overflow;
        const midY = Math.round(AREA.height / 2);
        const border = csLeft.rect.x + csLeft.rect.width;
        display.pointer(border, midY);
        manager.beginResize(csLeft.window, ['e']);
        display.pointer(border + drag, midY);
        await sleep(160);
        manager.endResize(csLeft.window);
        await sleep(300);
        csLayout.tree.layout(AREA);
        check('级联 · 中间那栏到最小尺寸之后，右边那栏接着让位',
            csLayout.tree.rectFor(csMid.window).width === minUnit &&
            csLayout.tree.rectFor(csRight.window).width === csRight.rect.width - overflow &&
            csLayout.tree.rectFor(csLeft.window).width === csLeft.rect.width + drag,
            `左 ${csLayout.tree.rectFor(csLeft.window).width} 中 ${csLayout.tree.rectFor(csMid.window).width} ` +
            `右 ${csLayout.tree.rectFor(csRight.window).width}（期望 ${csRight.rect.width - overflow}）`);
        checkNoGaps('级联', csLayout.tree.windows());
        checkNoOverlap('级联', csLayout.tree.windows());
    }

    /*
     * 对话框：弹出时父窗口保持最大化，也不因为焦点落到对话框而取消最大化。
     */
    const dlgWorkspace = 38;
    display.activateWorkspace(dlgWorkspace);
    const dp1 = display.createWindow('dp1', dlgWorkspace);
    await settle();
    const dp2 = display.createWindow('dp2', dlgWorkspace);
    await settle();
    dp1.touchedByUser();
    dp1.maximize(Meta.MaximizeFlags.BOTH);
    await settle();
    const dpLayout = manager.store.get(display.workspace(dlgWorkspace), 0);
    check('对话框 · 准备：父窗口最大化', dpLayout.maximized === dp1 &&
        dp1.get_maximize_flags() !== 0, `maximized=${dpLayout.maximized?.title ?? 'null'}`);
    const dpDialog = display.createDialog('dpDialog', dp1, dlgWorkspace);
    await settle();
    check('对话框 · 弹出时父窗口保持最大化（不取消最大化）',
        dp1.get_maximize_flags() !== 0 && dpLayout.maximized === dp1,
        `flags=${dp1.get_maximize_flags()} maximized=${dpLayout.maximized?.title ?? 'null'}`);
    dpDialog.destroy();
    display.windows = display.windows.filter(w => w !== dpDialog);
    await settle();
    check('对话框 · 关掉之后父窗口仍然最大化', dp1.get_maximize_flags() !== 0,
        `flags=${dp1.get_maximize_flags()}`);

    /*
     * 对话框：开着的时候不重新平铺父窗口；关掉之后父窗口回到自己的格子。
     */
    const dlgWorkspace2 = 39;
    display.activateWorkspace(dlgWorkspace2);
    const tp1 = display.createWindow('tp1', dlgWorkspace2);
    await settle();
    const tp2 = display.createWindow('tp2', dlgWorkspace2);
    await settle();
    const tpLayout = manager.store.get(display.workspace(dlgWorkspace2), 0);
    // 父窗口用「左下角那个」：新窗口会切开它的格子，正好验证开着对话框时不重新平铺它
    const tpFrame = tp2.get_frame_rect();
    const tpDialog = display.createDialog('tpDialog', tp2, dlgWorkspace2);
    await settle();
    const tp3 = display.createWindow('tp3', dlgWorkspace2);
    await settle();
    tpLayout.tree.layout(AREA);
    check('对话框 · 开着期间父窗口不跟着重新平铺（几何保持原样）',
        sameRect(tp2.get_frame_rect(), tpFrame) &&
        !sameRect(tpLayout.tree.rectFor(tp2), tpFrame),
        `父窗口 ${fmt(tp2.get_frame_rect())} 格子 ${fmt(tpLayout.tree.rectFor(tp2))}`);
    tpDialog.destroy();
    display.windows = display.windows.filter(w => w !== tpDialog);
    await settle();
    await sleep(200);
    tpLayout.tree.layout(AREA);
    check('对话框 · 关掉之后父窗口回到自己的格子',
        sameRect(tp2.get_frame_rect(), tpLayout.tree.rectFor(tp2)),
        `${fmt(tp2.get_frame_rect())} 期望 ${fmt(tpLayout.tree.rectFor(tp2))}`);
    checkNoGaps('对话框关闭之后', tpLayout.tree.windows());
    checkNoOverlap('对话框关闭之后', tpLayout.tree.windows());

    /*
     * 自主调整：窗口自己改尺寸 / 挪位置时，邻近窗口跟着调整（不是把它拽回去）。
     */
    const selfWorkspace = 40;
    display.activateWorkspace(selfWorkspace);
    const sf1 = display.createWindow('sf1', selfWorkspace);
    await settle();
    const sf2 = display.createWindow('sf2', selfWorkspace);
    await settle();
    manager.dropAt(sf2, 4, 40);
    await settle();
    const sf3 = display.createWindow('sf3', selfWorkspace);
    await settle();
    manager.dropAt(sf3, 4, 40);
    await settle();
    const sfLayout = manager.store.get(display.workspace(selfWorkspace), 0);
    sfLayout.tree.layout(AREA);
    const sfCols = sfLayout.tree.windows()
        .map(window => ({window, rect: sfLayout.tree.rectFor(window)}))
        .sort((a, b) => a.rect.x - b.rect.x);
    if (sfCols.length === 3) {
        const [sfLeft, sfMid, sfRight] = sfCols;
        // 中间那栏自己变宽 60：右边那栏吸收
        sfMid.window.resizeTo({
            x: sfMid.rect.x, y: sfMid.rect.y,
            width: sfMid.rect.width + 60, height: sfMid.rect.height,
        });
        await settle();
        await sleep(200);
        sfLayout.tree.layout(AREA);
        check('自主调整 · 窗口自己变宽，邻近窗口吸收',
            sfLayout.tree.rectFor(sfMid.window).width === sfMid.rect.width + 60 &&
            sfLayout.tree.rectFor(sfRight.window).width === sfRight.rect.width - 60 &&
            sfLayout.tree.rectFor(sfLeft.window).width === sfLeft.rect.width,
            `中 ${sfLayout.tree.rectFor(sfMid.window).width} 右 ${sfLayout.tree.rectFor(sfRight.window).width}`);
        checkNoGaps('自主调整（尺寸）', sfLayout.tree.windows());
        checkNoOverlap('自主调整（尺寸）', sfLayout.tree.windows());

        // 中间那栏自己往左挪 50（宽度不变）：左边让出、右边补上
        const beforeMove = sfLayout.tree.rectFor(sfMid.window);
        sfMid.window.resizeTo({
            x: beforeMove.x - 50, y: beforeMove.y,
            width: beforeMove.width, height: beforeMove.height,
        });
        await settle();
        await sleep(200);
        sfLayout.tree.layout(AREA);
        check('自主调整 · 窗口自己挪位置，两侧邻近窗口跟着调整',
            sameRect(sfLayout.tree.rectFor(sfMid.window), {
                x: beforeMove.x - 50, y: beforeMove.y,
                width: beforeMove.width, height: beforeMove.height,
            }),
            `中 ${fmt(sfLayout.tree.rectFor(sfMid.window))}`);
        checkNoGaps('自主调整（位置）', sfLayout.tree.windows());
        checkNoOverlap('自主调整（位置）', sfLayout.tree.windows());
    }

    /*
     * 行高规则：
     *   · 在分栏里的两个窗口之间插入新行 → 这一栏的行高均分；
     *   · 关掉一个窗口 → 这一栏剩下的行高均分；
     *   · 只有「新开一个窗口」保持原样（切开左下角那个窗口，各占一半）。
     */
    const rowRuleWorkspace = 41;
    display.activateWorkspace(rowRuleWorkspace);
    const rr1 = display.createWindow('rr1', rowRuleWorkspace);
    await settle();
    const rr2 = display.createWindow('rr2', rowRuleWorkspace);
    await settle();
    const rr3 = display.createWindow('rr3', rowRuleWorkspace);
    await settle();
    const rrLayout = manager.store.get(display.workspace(rowRuleWorkspace), 0);
    const rrRowOf = window => rrLayout.tree.rectFor(window);
    const rrHeightsOf = windows => windows.map(w => rrRowOf(w).height);
    const rrEqual = ns => Math.max(...ns) - Math.min(...ns) <= 1;
    check('行高规则 · 新开窗口之后这一栏的行高也会均分',
        rrEqual(rrHeightsOf([rr1, rr2, rr3])) &&
        rrHeightsOf([rr1, rr2, rr3]).reduce((a, b) => a + b, 0) === AREA.height,
        `高度=${rrHeightsOf([rr1, rr2, rr3]).join('/')}`);

    const rr4 = display.createWindow('rr4', rowRuleWorkspace);
    await settle();
    check('行高规则 · 再加一个窗口之后四行均分',
        rrEqual(rrHeightsOf([rr1, rr2, rr3, rr4])) &&
        rrHeightsOf([rr1, rr2, rr3, rr4]).reduce((a, b) => a + b, 0) === AREA.height,
        `高度=${rrHeightsOf([rr1, rr2, rr3, rr4]).join('/')}`);

    // 把 rr4 拖到 rr1 / rr2 之间：这一栏变成三行 → 行高均分
    manager.dropAt(rr4, Math.round(AREA.width / 2), 404);
    await sleep(400);
    rrLayout.tree.layout(AREA);
    const rrHeights = [rr1, rr2, rr3, rr4].map(w => rrRowOf(w).height).sort((a, b) => b - a);
    check('行高规则 · 两行之间插入新行之后，这一栏的行高均分',
        rrLayout.tree.windows().length === 4 &&
        Math.max(...rrHeights) - Math.min(...rrHeights) <= 1 &&
        rrHeights.reduce((a, b) => a + b, 0) === AREA.height,
        `高度=${rrHeights.join('/')}`);
    checkNoGaps('行高规则（插入行之后）', rrLayout.tree.windows());
    checkNoOverlap('行高规则（插入行之后）', rrLayout.tree.windows());

    // 关掉一个窗口：剩下的行高均分
    const rowCloseWorkspace = 42;
    display.activateWorkspace(rowCloseWorkspace);
    const rc1 = display.createWindow('rc1', rowCloseWorkspace);
    await settle();
    const rc2 = display.createWindow('rc2', rowCloseWorkspace);
    await settle();
    const rc3 = display.createWindow('rc3', rowCloseWorkspace);
    await settle();
    const rcLayout = manager.store.get(display.workspace(rowCloseWorkspace), 0);
    rcLayout.tree.layout(AREA);
    // 先手动把下面两行拖成 300 / 100
    const rc2Rect = rcLayout.tree.rectFor(rc2);
    display.pointer(0, rc2Rect.y + rc2Rect.height);
    manager.beginResize(rc2, ['s']);
    display.pointer(0, rc2Rect.y + rc2Rect.height + 100);
    await sleep(120);
    manager.endResize(rc2);
    await sleep(300);
    rcLayout.tree.layout(AREA);
    check('行高规则 · 准备：下面两行被拖成不等高',
        rcLayout.tree.rectFor(rc2).height !== rcLayout.tree.rectFor(rc3).height,
        `${fmt(rcLayout.tree.rectFor(rc2))} ${fmt(rcLayout.tree.rectFor(rc3))}`);

    rc1.destroy();
    display.windows = display.windows.filter(w => w !== rc1);
    await settle();
    await sleep(300);
    rcLayout.tree.layout(AREA);
    check('行高规则 · 关掉一个窗口之后剩下的行高均分',
        rcLayout.tree.rectFor(rc2).height === 400 && rcLayout.tree.rectFor(rc3).height === 400,
        `${fmt(rcLayout.tree.rectFor(rc2))} ${fmt(rcLayout.tree.rectFor(rc3))}`);
    checkNoGaps('行高规则（关闭窗口之后）', rcLayout.tree.windows());
    checkNoOverlap('行高规则（关闭窗口之后）', rcLayout.tree.windows());

    /*
     * 把窗口拖出分栏：原来那一栏少了一行 → 剩下各行的高度均分。
     */
    const pullWorkspace = 43;
    display.activateWorkspace(pullWorkspace);
    const pw1 = display.createWindow('pw1', pullWorkspace);
    await settle();
    const pw2 = display.createWindow('pw2', pullWorkspace);
    await settle();
    const pw3 = display.createWindow('pw3', pullWorkspace);
    await settle();
    const pwLayout = manager.store.get(display.workspace(pullWorkspace), 0);
    pwLayout.tree.layout(AREA);
    const pwHeights = () => [pw1, pw2, pw3].map(w => pwLayout.tree.rectFor(w).height);
    check('拖出分栏 · 准备：一栏三行（新开窗口也均分）',
        Math.max(...pwHeights()) - Math.min(...pwHeights()) <= 1,
        `高度=${pwHeights().join('/')}`);

    // 先把这一栏拖成不等高
    const pwBorder = pwLayout.tree.rectFor(pw1).y + pwLayout.tree.rectFor(pw1).height;
    display.pointer(0, pwBorder);
    manager.beginResize(pw1, ['s']);
    display.pointer(0, pwBorder + 150);
    await sleep(140);
    manager.endResize(pw1);
    await sleep(300);
    pwLayout.tree.layout(AREA);
    check('拖出分栏 · 准备：三行不等高',
        Math.abs(pwLayout.tree.rectFor(pw1).height - 400) > 1 &&
        Math.abs(pwLayout.tree.rectFor(pw3).height - 200) > 1,
        `${fmt(pwLayout.tree.rectFor(pw1))} ${fmt(pwLayout.tree.rectFor(pw2))} ${fmt(pwLayout.tree.rectFor(pw3))}`);

    // 把最下面那行拖到 pw1 的右边 → 成为新的一栏；原来那一栏剩两行
    manager.dropAt(pw3, AREA.width - 4, 100);
    await sleep(400);
    pwLayout.tree.layout(AREA);
    check('拖出分栏 · 剩下那一栏的行高均分',
        pwLayout.tree.rectFor(pw1).height === pwLayout.tree.rectFor(pw2).height &&
        pwLayout.tree.rectFor(pw1).height === 400 &&
        pwLayout.tree.rectFor(pw3).height === AREA.height,
        `${fmt(pwLayout.tree.rectFor(pw1))} ${fmt(pwLayout.tree.rectFor(pw2))} ${fmt(pwLayout.tree.rectFor(pw3))}`);
    checkNoGaps('拖出分栏', pwLayout.tree.windows());
    checkNoOverlap('拖出分栏', pwLayout.tree.windows());

    /* 拖到别的工作区也是「拖出分栏」：原桌面剩下的行高均分。 */
    const pullWorkspace2 = 44;
    const pullOtherWorkspace = 45;
    display.workspace(pullOtherWorkspace);
    display.activateWorkspace(pullWorkspace2);
    const px1 = display.createWindow('px1', pullWorkspace2);
    await settle();
    const px2 = display.createWindow('px2', pullWorkspace2);
    await settle();
    const px3 = display.createWindow('px3', pullWorkspace2);
    await settle();
    const pxLayout = manager.store.get(display.workspace(pullWorkspace2), 0);
    pxLayout.tree.layout(AREA);
    // 把下面两行拖成 260 / 140
    display.pointer(0, 600);
    manager.beginResize(px2, ['s']);
    display.pointer(0, 660);
    await sleep(140);
    manager.endResize(px2);
    await sleep(300);
    pxLayout.tree.layout(AREA);
    check('拖出分栏 · 准备：下面两行不等高',
        pxLayout.tree.rectFor(px2).height !== pxLayout.tree.rectFor(px3).height,
        `${fmt(pxLayout.tree.rectFor(px2))} ${fmt(pxLayout.tree.rectFor(px3))}`);

    px1.moveToWorkspace(pullOtherWorkspace);
    await settle();
    await sleep(300);
    pxLayout.tree.layout(AREA);
    const pxRemaining = [px2, px3].map(w => pxLayout.tree.rectFor(w)).filter(Boolean);
    check('拖出分栏 · 拖到别的工作区之后，原桌面剩下的行高均分',
        pxRemaining.length === 2 && Math.abs(pxRemaining[0].height - pxRemaining[1].height) <= 1 &&
        pxRemaining[0].height === 400,
        `行高=${pxRemaining.map(r => r.height).join('/')}`);
    checkNoGaps('拖出分栏（跨桌面）', pxLayout.tree.windows());
    checkNoOverlap('拖出分栏（跨桌面）', pxLayout.tree.windows());

    /*
     * 最小化 / 还原也算「分栏里窗口增减」：剩下的、以及还原之后的行高都均分。
     */
    const minRowsWorkspace = 46;
    display.activateWorkspace(minRowsWorkspace);
    const mn1 = display.createWindow('mn1', minRowsWorkspace);
    await settle();
    const mn2 = display.createWindow('mn2', minRowsWorkspace);
    await settle();
    const mn3 = display.createWindow('mn3', minRowsWorkspace);
    await settle();
    const mnLayout = manager.store.get(display.workspace(minRowsWorkspace), 0);
    mnLayout.tree.layout(AREA);
    const mnBorder = mnLayout.tree.rectFor(mn1).y + mnLayout.tree.rectFor(mn1).height;
    display.pointer(0, mnBorder);
    manager.beginResize(mn1, ['s']);
    display.pointer(0, mnBorder + 120);
    await sleep(140);
    manager.endResize(mn1);
    await sleep(300);
    mnLayout.tree.layout(AREA);
    check('行高均分 · 准备：三行不等高',
        new Set([mn1, mn2, mn3].map(w => mnLayout.tree.rectFor(w).height)).size > 1,
        `${fmt(mnLayout.tree.rectFor(mn1))} ${fmt(mnLayout.tree.rectFor(mn2))} ${fmt(mnLayout.tree.rectFor(mn3))}`);

    mn3.minimize();
    await settle();
    await sleep(200);
    mnLayout.tree.layout(AREA);
    check('行高均分 · 最小化之后剩下的行高均分',
        Math.abs(mnLayout.tree.rectFor(mn1).height - mnLayout.tree.rectFor(mn2).height) <= 1 &&
        mnLayout.tree.rectFor(mn1).height === 400,
        `${fmt(mnLayout.tree.rectFor(mn1))} ${fmt(mnLayout.tree.rectFor(mn2))}`);
    mn3.unminimize();
    await settle();
    await sleep(300);
    mnLayout.tree.layout(AREA);
    const mnHeights = [mn1, mn2, mn3].map(w => mnLayout.tree.rectFor(w).height);
    check('行高均分 · 还原之后整栏行高均分',
        Math.max(...mnHeights) - Math.min(...mnHeights) <= 1 &&
        mnHeights.reduce((a, b) => a + b, 0) === AREA.height,
        `高度=${mnHeights.join('/')}`);
    checkNoGaps('行高均分（最小化 / 还原）', mnLayout.tree.windows());
    checkNoOverlap('行高均分（最小化 / 还原）', mnLayout.tree.windows());

    /*
     * 分栏数变少（某一栏唯一的窗口被拖进别的栏、整栏消失）→ 剩下的分栏宽度均分。
     */
    const colDropWorkspace = 47;
    display.activateWorkspace(colDropWorkspace);
    const cd1 = display.createWindow('cd1', colDropWorkspace);
    await settle();
    const cd2 = display.createWindow('cd2', colDropWorkspace);   // 上下两行
    await settle();
    const cd3 = display.createWindow('cd3', colDropWorkspace);
    await settle();
    manager.dropAt(cd3, AREA.width - 4, 40);        // cd3 成为右边的一栏
    await settle();
    const cd4 = display.createWindow('cd4', colDropWorkspace);
    await settle();
    manager.dropAt(cd4, AREA.width - 4, 40);        // cd4 成为新的最右栏
    await settle();
    const cdLayout = manager.store.get(display.workspace(colDropWorkspace), 0);
    cdLayout.tree.layout(AREA);
    // 手动拖宽中间那栏，做出不等宽
    const cdCols = cdLayout.tree.windows()
        .map(w => ({window: w, rect: cdLayout.tree.rectFor(w)}))
        .sort((a, b) => a.rect.x - b.rect.x);
    check('宽度均分 · 准备：三栏 + 左栏两行',
        cdLayout.tree.columnCount() === 3, `栏数=${cdLayout.tree.columnCount()}`);
    const leftWindows = [cd1, cd2].filter(w => cdLayout.tree.findLeaf(w));
    const columnXs = [...new Set(cdLayout.tree.windows()
        .map(w => cdLayout.tree.rectFor(w).x))].sort((a, b) => a - b);
    const middleWindow = columnXs.length >= 2
        ? cdLayout.tree.windows().find(w => cdLayout.tree.rectFor(w).x === columnXs[1]) ?? null
        : null;
    if (columnXs.length === 3 && leftWindows.length === 2 && middleWindow) {
        // 把中间那一栏唯一的窗口拖到左栏两行之间的分界线 → 它变成左栏的一行，
        // 中间那一栏整体消失
        const topRow = leftWindows
            .map(w => ({window: w, rect: cdLayout.tree.rectFor(w)}))
            .sort((a, b) => a.rect.y - b.rect.y)[0];
        const dividerY = topRow.rect.y + topRow.rect.height;
        manager.dropAt(middleWindow, topRow.rect.x + Math.round(topRow.rect.width / 2), dividerY);
        await sleep(400);
        cdLayout.tree.layout(AREA);
        const widths = cdLayout.tree.windows().map(w => cdLayout.tree.rectFor(w).width);
        check('宽度均分 · 分栏少了一个之后剩下的分栏等宽',
            cdLayout.tree.columnCount() === 2 &&
            Math.max(...widths) - Math.min(...widths) <= 1,
            `栏数=${cdLayout.tree.columnCount()} 宽度=${widths.join('/')}`);
        checkNoGaps('宽度均分（删除分栏）', cdLayout.tree.windows());
        checkNoOverlap('宽度均分（删除分栏）', cdLayout.tree.windows());
    }

    /*
     * 落点预览：插入型落点（窗口之间 / 贴边 / 屏幕边缘）用「间隙高亮」表示。
     * 这里只验证判定 → 预览形态（St.Widget 需要 Clutter 上下文，mock 里不创建）。
     */
    const previewWorkspace = 48;
    display.activateWorkspace(previewWorkspace);
    const pv1 = display.createWindow('pv1', previewWorkspace);
    await settle();
    const pv2 = display.createWindow('pv2', previewWorkspace);
    await settle();
    manager.dropAt(pv2, 4, 40);                     // 左右两个分栏
    await settle();
    const pvLayout = manager.store.get(display.workspace(previewWorkspace), 0);
    pvLayout.tree.layout(AREA);
    const pvCols = pvLayout.tree.windows()
        .map(w => ({window: w, rect: pvLayout.tree.rectFor(w)}))
        .sort((a, b) => a.rect.x - b.rect.x);
    if (pvCols.length === 2) {
        const midY = Math.round(AREA.height / 2);
        const boundary = pvCols[0].rect.x + pvCols[0].rect.width;
        const betweenPlan = manager._planFor(pvCols[0].window, pvLayout, [boundary, midY]);
        const betweenPreview = manager._previewFor(betweenPlan);
        check('落点预览 · 两个窗口之间用间隙高亮（细长条）',
            betweenPreview?.gap === true && betweenPreview.rect.width === 6 &&
            betweenPreview.rect.height === AREA.height,
            betweenPreview ? `${betweenPreview.rect.width}x${betweenPreview.rect.height}` : '没有预览');

        // 把右边那个窗口拖到左边窗口的左边缘（= 工作区边缘）→ 也是间隙高亮
        const edgePlan = manager._planFor(pvCols[1].window, pvLayout, [4, midY]);
        const edgePreview = manager._previewFor(edgePlan);
        check('落点预览 · 屏幕边缘插入也用间隙高亮',
            edgePreview?.gap === true && edgePreview.rect.width === 6 &&
            edgePreview.rect.height === AREA.height && edgePreview.rect.x === -3,
            edgePreview ? `${edgePreview.rect.x},${edgePreview.rect.width}x${edgePreview.rect.height}` : '没有预览');

        // 交换位置仍然画目标格子（不是间隙）
        const swapPlan = manager._planFor(pvCols[0].window, pvLayout,
            [pvCols[1].rect.x + Math.round(pvCols[1].rect.width / 2), midY]);
        const swapPreview = manager._previewFor(swapPlan);
        check('落点预览 · 交换位置仍然高亮目标格子',
            swapPreview?.gap === false && swapPreview.rect.width === pvCols[1].rect.width,
            swapPreview ? `${swapPreview.gap} ${swapPreview.rect.width}` : '没有预览');
    }

    /*
     * 屏幕左右竖边：拖到这条边的任何高度都插出一个新分栏（不会被行分界线抢走）。
     */
    const edgeDropWorkspace = 49;
    display.activateWorkspace(edgeDropWorkspace);
    const ed1 = display.createWindow('ed1', edgeDropWorkspace);
    await settle();
    const ed2 = display.createWindow('ed2', edgeDropWorkspace);
    await settle();
    const ed3 = display.createWindow('ed3', edgeDropWorkspace);
    await settle();
    manager.dropAt(ed3, AREA.width - 4, 40);        // ed3 成为右边的分栏
    await settle();
    const edLayout = manager.store.get(display.workspace(edgeDropWorkspace), 0);
    edLayout.tree.layout(AREA);
    const edLeftRows = [ed1, ed2].filter(w => edLayout.tree.findLeaf(w));
    const edDivider = edLeftRows.length
        ? edLayout.tree.rectFor(edLeftRows[0]).y + edLayout.tree.rectFor(edLeftRows[0]).height
        : 0;
    // 指针正好压在左列的行分界线高度上、同时贴着屏幕左边
    manager.dropAt(ed3, 3, edDivider);
    await sleep(400);
    edLayout.tree.layout(AREA);
    const ed3Rect = edLayout.tree.rectFor(ed3);
    const edColumnRows = [ed1, ed2].filter(w => edLayout.tree.findLeaf(w))
        .map(w => edLayout.tree.rectFor(w)).filter(Boolean);
    check('屏幕竖边 · 贴着左边缘任何高度都插出一栏（不会被当成插新行）',
        edLayout.tree.columnCount() === 2 && ed3Rect && ed3Rect.x === AREA.x &&
        ed3Rect.height === AREA.height && edColumnRows.length === 2 &&
        Math.abs(ed3Rect.width - edColumnRows[0].width) <= 1,
        `栏数=${edLayout.tree.columnCount()} ed3=${fmt(ed3Rect)} ` +
        `另一栏行数=${edColumnRows.length}`);
    checkNoGaps('屏幕竖边插入', edLayout.tree.windows());
    checkNoOverlap('屏幕竖边插入', edLayout.tree.windows());
    // 最左边那一栏的窗口再拖到左竖边：依然是一次平铺落点（不会失效）
    const edSelfPlan = manager._planFor(ed3, edLayout, [3, 200]);
    check('屏幕竖边 · 拖最外侧那一栏的窗口也仍然平铺',
        edSelfPlan.action === 'edge' && edSelfPlan.detail?.screenEdge === true &&
        !!edSelfPlan.gapRect, `action=${edSelfPlan.action}`);

    /*
     * 屏幕横边（上下）：对应到「自己那一栏」的那一段不触发插入；屏幕竖边则
     * 高亮整条边框（整个屏幕高度）。
     */
    const horizonWorkspace = 50;
    display.activateWorkspace(horizonWorkspace);
    const hz1 = display.createWindow('hz1', horizonWorkspace);
    await settle();
    const hz2 = display.createWindow('hz2', horizonWorkspace);
    await settle();
    const hz3 = display.createWindow('hz3', horizonWorkspace);
    await settle();
    manager.dropAt(hz3, AREA.width - 4, 40);        // hz3 成为右边的分栏
    await settle();
    const hzLayout = manager.store.get(display.workspace(horizonWorkspace), 0);
    hzLayout.tree.layout(AREA);
    const hzRows = () => [hz1, hz2].filter(w => hzLayout.tree.findLeaf(w)).length;
    const hzRowsBefore = hzRows();

    // 把左栏下面那行拖到同一栏最上面的横边（屏幕顶边 + 自己这一栏）：
    // 在本栏内平铺 —— 移到本栏顶部，行高均分，不会插出新分栏
    manager.dropAt(hz2, 200, 4);
    await sleep(400);
    hzLayout.tree.layout(AREA);
    check('屏幕横边 · 自己那一栏的顶边在本栏内平铺（移到顶部、不跑出本栏）',
        hzRows() === hzRowsBefore && hzLayout.tree.columnCount() === 2 &&
        hzLayout.tree.rectFor(hz2).y < hzLayout.tree.rectFor(hz1).y &&
        hzLayout.tree.rectFor(hz1).height === hzLayout.tree.rectFor(hz2).height,
        `行数=${hzRows()}（之前 ${hzRowsBefore}） 栏数=${hzLayout.tree.columnCount()} ` +
        `hz1=${fmt(hzLayout.tree.rectFor(hz1))} hz2=${fmt(hzLayout.tree.rectFor(hz2))}`);
    checkNoGaps('屏幕横边（自己那一栏）', hzLayout.tree.windows());
    checkNoOverlap('屏幕横边（自己那一栏）', hzLayout.tree.windows());

    // 屏幕顶部（横边带）里，拖到「别的分栏」上方同样不触发插入
    hzLayout.tree.layout(AREA);
    const hzAnother = hzLayout.tree.windows().find(w => w !== hz3) ?? hz1;
    const hzAnotherRect = hzLayout.tree.rectFor(hzAnother);
    const hzTopPlan = manager._planFor(hz3, hzLayout,
        [hzAnotherRect.x + Math.round(hzAnotherRect.width / 2), 4]);
    check('屏幕横边 · 顶部带里拖到别的分栏仍然能移动窗口',
        hzTopPlan.action === 'edge' && hzTopPlan.detail?.unit === 'row' && !!hzTopPlan.gapRect,
        `action=${hzTopPlan.action}`);

    // 拖到左屏幕竖边：预览高亮整条边框（整个屏幕高度）
    const hzPlan = manager._planFor(hz3, hzLayout, [3, 120]);
    const hzPreview = manager._previewFor(hzPlan);
    check('屏幕竖边 · 高亮整条边框（整个屏幕高度）',
        hzPlan.action === 'edge' && hzPlan.detail.screenEdge === true &&
        hzPreview?.gap === true && hzPreview.rect.height === AREA.height &&
        hzPreview.rect.width === 6 && hzPreview.rect.x === -3,
        hzPreview ? `${hzPreview.rect.x},${hzPreview.rect.y} ${hzPreview.rect.width}x${hzPreview.rect.height}` : '没有预览');

    /*
     * 预览边框像素：两种落点预览共用 preview-border-width（目标格子的 CSS 边框 +
     * 间隙高亮的粗细都由它决定）。
     */
    const borderWorkspace = 51;
    display.activateWorkspace(borderWorkspace);
    const bw1 = display.createWindow('bw1', borderWorkspace);
    await settle();
    const bw2 = display.createWindow('bw2', borderWorkspace);
    await settle();
    manager.dropAt(bw2, 4, 40);                     // 左右两个分栏
    await settle();
    const bwLayout = manager.store.get(display.workspace(borderWorkspace), 0);
    bwLayout.tree.layout(AREA);
    const bwCols = bwLayout.tree.windows()
        .map(w => ({window: w, rect: bwLayout.tree.rectFor(w)}))
        .sort((a, b) => a.rect.x - b.rect.x);
    check('预览边框 · 默认 6px', settings.get_int('preview-border-width') === 6,
        `值=${settings.get_int('preview-border-width')}`);
    if (bwCols.length === 2) {
        settings.set_int('preview-border-width', 11);
        const midY = Math.round(AREA.height / 2);
        const boundary = bwCols[0].rect.x + bwCols[0].rect.width;
        const betweenPlan = manager._planFor(bwCols[0].window, bwLayout, [boundary, midY]);
        const betweenPreview = manager._previewFor(betweenPlan);
        check('预览边框 · 间隙高亮粗细跟随设置（11px）',
            betweenPreview?.gap === true && betweenPreview.rect.width === 11,
            betweenPreview ? `${betweenPreview.rect.width}` : '没有预览');
        const edgePlan = manager._planFor(bwCols[1].window, bwLayout, [3, midY]);
        const edgePreview = manager._previewFor(edgePlan);
        check('预览边框 · 贴屏幕竖边时也是同一个像素值',
            edgePreview?.gap === true && edgePreview.rect.width === 11,
            edgePreview ? `${edgePreview.rect.width}` : '没有预览');

        // 最小 1px
        settings.set_int('preview-border-width', 1);
        const thinPreview = manager._previewFor(
            manager._planFor(bwCols[0].window, bwLayout, [boundary, midY]));
        check('预览边框 · 最小 1px',
            thinPreview?.gap === true && thinPreview.rect.width === 1,
            thinPreview ? `${thinPreview.rect.width}` : '没有预览');
        settings.reset('preview-border-width');
    }

    /*
     * 开关：平铺生效期间接管 mutter 的贴边吸附（拖到屏幕边缘由本扩展负责），
     * 一旦从系统菜单里把平铺关掉，就得把吸附还给用户 —— 而且是**彻底放手**：
     * 关掉之后窗口不再被摆布，否则用户自己拖到边缘做的吸附会被扩展当成
     * 「平铺里的最大化」再撤掉，看起来就是系统自带的吸附坏了。
     * 这一段放在最后：关掉再打开会清空布局状态（重新接管）。
     */
    const mutterSettings = new Gio.Settings({schema_id: 'org.gnome.mutter'});
    check('开关 · 平铺生效期间关掉 mutter 的贴边吸附（避免两套落点逻辑打架）',
        mutterSettings.get_boolean('edge-tiling') === false,
        `edge-tiling=${mutterSettings.get_boolean('edge-tiling')}`);
    check('开关 · 接管之前用户的值被记在了扩展自己的设置里',
        settings.get_string('mutter-edge-tiling-backup') === 'true',
        `backup="${settings.get_string('mutter-edge-tiling-backup')}"`);

    const offWorkspace = 20;
    display.activateWorkspace(offWorkspace);
    const offWindow = display.createWindow('off1', offWorkspace);
    await settle();
    check('开关 · 平铺生效时新窗口照常铺满',
        sameRect(offWindow.get_frame_rect(), AREA), fmt(offWindow.get_frame_rect()));

    settings.set_boolean('enabled', false);   // 从系统菜单里关掉平铺
    await settle();
    check('开关 · 关掉平铺后 mutter 的贴边吸附被写回来',
        mutterSettings.get_boolean('edge-tiling') === true,
        `edge-tiling=${mutterSettings.get_boolean('edge-tiling')}`);
    check('开关 · 归还之后就清掉备忘（不会把 false 当成用户的选择继承下去）',
        settings.get_string('mutter-edge-tiling-backup') === '',
        `backup="${settings.get_string('mutter-edge-tiling-backup')}"`);
    for (const window of [offWindow, ov1])
        window.moves = 0;
    const lateWindow = display.createWindow('off2', offWorkspace);
    await settle();
    check('开关 · 关掉平铺后新窗口不再被接管（保持 mutter 给的位置）',
        !lateWindow.minimized && !sameRect(lateWindow.get_frame_rect(), AREA) &&
        offWindow.moves === 0,
        `${fmt(lateWindow.get_frame_rect())}；旧窗口被写 ${offWindow.moves} 次`);

    // 关着平铺时用户自己贴边吸附：扩展不能再插手（不能把它撤掉）
    offWindow.maximize(Meta.MaximizeFlags.BOTH);
    await settle();
    check('开关 · 关掉平铺后用户自己做的贴边吸附不会被撤掉',
        offWindow.get_maximize_flags() !== 0, `flags=${offWindow.get_maximize_flags()}`);

    settings.set_boolean('enabled', true);    // 收尾：把平铺打开，验证能重新接管
    await settle();
    check('开关 · 重新打开平铺后接管回来（mutter 的吸附再次关闭）',
        mutterSettings.get_boolean('edge-tiling') === false &&
        manager.store.get(display.workspace(offWorkspace), 0)?.tree.windows().includes(lateWindow) === true,
        `edge-tiling=${mutterSettings.get_boolean('edge-tiling')}`);

    /* ---------------- 收尾 ---------------- */
    const failed = results.filter(result => !result.pass);
    print('');
    print(`模拟 shell 流程：${results.length - failed.length}/${results.length} 通过`);
    return failed.length === 0;
}

// 先注册 shell 桩资源（ui/main.js），再动态 import 被测代码。
Gio.resources_register(Gio.Resource.load(ARGV[0]));

let ok = false;

GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
    (async () => {
        try {
            const {TilingManager} = await import('../../lib/tilingManager.js');
            ok = await suite(TilingManager);
        } catch (error) {
            printerr(`测试脚本异常: ${error}\n${error?.stack ?? ''}`);
            ok = false;
        } finally {
            loop.quit();
        }
    })();
    return GLib.SOURCE_REMOVE;
});

loop.run();

if (!ok)
    imports.system.exit(1);
