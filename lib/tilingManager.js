// SPDX-License-Identifier: MIT
/*
 * tilingManager.js —— 把布局引擎接到 GNOME Shell 上的那一层。
 *
 * 需求与实现的对应关系（README 里有更详细的说明）：
 *   1. 第一个窗口铺满工作区，且不进入最大化状态   → _placeNewWindow / _applyRect
 *   2. 新窗口顶替焦点窗口的格子，原窗口最小化     → _placeNewWindow
 *   3. 恢复最小化的窗口时与其余窗口平铺           → _restoreWindow
 *   4. 拖到边缘 / 两窗口之间 / 另一个窗口上       → _onGrabBegin/_onGrabEnd + dropAt
 *   5. 拖动窗口边缘时其余窗口联动缩放             → _onResizeProgress
 *   6. 每桌面至多一个最大化窗口、取消后恢复布局   → _onMaximizeChanged
 *   7. 移到非空白桌面则最小化，否则按 1~6 处理    → _relocate
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {DROP_BETWEEN, DROP_EDGE, DROP_NONE, planDrop} from './dropTarget.js';
import {LayoutStore} from './layoutStore.js';
import {DropPreview} from './preview.js';
import {isTilableWindow} from './windowFilter.js';

/**
 * 新窗口登场后多久之内，它带出来的最大化状态可能是「应用自己要求的」。
 * 还要配合「用户有没有碰过这个窗口」一起判断，见 TilingManager._isSelfMaximize。
 */
/**
 * 「客户端一直不照做」要持续多久才认定是它自己的尺寸限制（毫秒）。
 *
 * 这个下限很关键：刚取消最大化、mutter 还没把旧几何恢复回来的那几百毫秒里，
 * 窗口同样会「卡在某个尺寸上不肯变」，但那不是尺寸限制。据此改写布局会把
 * 分界线钉到那个尺寸上 —— 表现出来就是相邻窗口突然被压到最小尺寸、
 * 分界线也不再跟着鼠标走。
 */
const ADOPT_SETTLE_MS = 900;

/**
 * 几何复核的梯级（毫秒，自写入那一刻算起）。
 * 客户端 / 合成器的几何是异步生效的，写一次不等于就位，所以按这个梯级看几次。
 */
const VERIFY_DELAYS = [150, 350, 600, 950, 1400, 2000];

/** 手动缩放期间按指针推算边界的轮询间隔（毫秒）。 */
const RESIZE_POLL_MS = 16;

/**
 * 相邻两次轮询之间，分界线允许跟着指针移动的最大距离（像素）。
 *
 * 指针读数偶尔会给出一个离谱的采样（主循环卡了一下、坐标一时没更新），
 * 直接采信会让分界线一步跳到极端位置 —— 表现出来就是「相邻窗口突然被压到
 * 最小尺寸」。这个上限比人手能达到的速度高得多（16ms 走 600px ≈ 37000px/s），
 * 只会拦住这种离谱采样；真的跟不上时下一帧就追上了。
 */
const MAX_POINTER_STEP = 600;

/** 同一个窗口两次「因尺寸限制而改写布局」之间的最短间隔（毫秒）。 */
const ADOPT_COOLDOWN_MS = 1500;

const NEW_WINDOW_GRACE_MS = 1500;

/**
 * 构建标记：只写到日志里，方便确认「现在跑的到底是不是刚装的那份代码」。
 * （Wayland 会话必须重新登录才会加载新代码，装完不重登会继续跑旧的。）
 */
const BUILD_TAG = 'codex-tiling 2026-10-26a-gs51';

const MOVE_OPS = [
    Meta.GrabOp.MOVING,
    Meta.GrabOp.KEYBOARD_MOVING,
    Meta.GrabOp.MOVING_UNCONSTRAINED,
];

/** 鼠标拖动的缩放操作 → 被移动的边（需求 5）。 */
const RESIZE_EDGES = new Map([
    [Meta.GrabOp.RESIZING_E, ['e']],
    [Meta.GrabOp.RESIZING_W, ['w']],
    [Meta.GrabOp.RESIZING_N, ['n']],
    [Meta.GrabOp.RESIZING_S, ['s']],
    [Meta.GrabOp.RESIZING_NE, ['n', 'e']],
    [Meta.GrabOp.RESIZING_NW, ['n', 'w']],
    [Meta.GrabOp.RESIZING_SE, ['s', 'e']],
    [Meta.GrabOp.RESIZING_SW, ['s', 'w']],
]);

export class TilingManager {
    constructor(settings, logger = null) {
        this._settings = settings;
        this._log = logger ?? console;

        this._display = global.display;
        this._workspaceManager = global.workspace_manager;
        this._store = new LayoutStore(this._workspaceManager);

        this._enabled = false;
        this._preview = null;
        this._signalIds = [];
        this._windowSignalIds = new WeakMap();
        this._managed = new Set();
        /**
         * 窗口的创建时刻：刚出现的窗口自己带着的最大化状态（应用主动最大化、
         * mutter 的摆放）不算「用户按下的最大化」，会被取消掉再平铺。
         */
        this._createdAt = new WeakMap();
        /** 窗口最近一次被我们摆放时的「用户操作时间」，用来区分用户最大化和应用自己的最大化。 */
        this._userTimeSeen = new WeakMap();
        this._refs = new Map(); // window -> {workspace, monitorIndex}
        this._recency = [];
        this._internalMinimize = new Set();
        this._internalUnminimize = new Set();
        this._internalMaximize = new Set();
        this._timeoutSources = new Set();
        this._guard = 0;
        this._drag = null;
        this._resize = null;
        this._mutterSettings = null;
        this._reevaluateTimer = 0;
        /** 手动缩放期间的指针轮询句柄。 */
        this._resizeTimer = 0;
        /**
         * 概览（应用网格）打开期间被**延后**的动作。这些动作不能丢：
         * 从概览里开新窗口、把窗口拖到别的桌面、在概览里切换窗口都发生在
         * 「概览可见」的时候，丢掉的话新窗口就不参与平铺、挪过来的窗口也进不了布局。
         * 等概览关掉（'hidden'）之后补做。
         */
        this._pendingRetile = false;
        this._pendingMaximizeCheck = false;
        /** 被摘出平铺的窗口：定期回看一眼，重新符合条件就接管回来。 */
        this._evicted = new Set();
        /** 打开的对话框 → 它的父窗口（有对话框时父窗口不重新平铺、也不取消最大化）。 */
        this._dialogs = new Map();
        /** 窗口自己改了位置 / 尺寸，等着让布局跟着它调整。 */
        this._selfGeometryPending = new Set();
        /**
         * 我们刚写过、但窗口没照做的那些窗口（几何复核还在排队）。这段时间里的
         * 几何变化是「客户端拒绝」而不是「窗口自主调整」，交给复核 / 迁就那条路径。
         */
        this._writeGuardUntil = new WeakMap();
        /**
         * 每个窗口最近一次「因尺寸限制而改写布局」的记录（当时的「格子 → 实际尺寸」
         * 组合 + 时间）：同一个僵局短时间内重复出现就不再反复改写，避免来回拉锯。
         */
        this._adopted = new WeakMap();
    }

    /* -------------------------------------------------------------- 生命周期 */

    enable() {
        if (this._enabled)
            return;
        this._enabled = true;
        this._log.log?.(`[codex-tiling] 启用 ${BUILD_TAG}`);

        this._connect(this._display, 'window-created', (_display, window) => this._onWindowCreated(window));
        this._connect(this._display, 'grab-op-begin', (_display, window, op) => this._onGrabBegin(window, op));
        this._connect(this._display, 'grab-op-end', (_display, window, op) => this._onGrabEnd(window, op));
        this._connect(this._display, 'notify::focus-window', () => this._onFocusChanged());
        this._connect(this._display, 'workareas-changed', () => this.retileAll());
        this._connect(this._display, 'window-entered-monitor', (_display, window) => this._onRelocate(window));
        this._connect(this._settings, 'changed::gap', () => {
            this._applySettingsToLayouts();
            this.retileAll();
        });
        this._connect(this._settings, 'changed::outer-gap', () => this.retileAll());
        this._connect(this._settings, 'changed::icon-area-inset', () => this.retileAll());
        this._connect(this._settings, 'changed::minimum-window-size', () => {
            this._applySettingsToLayouts();
            this.retileAll();
        });
        this._connect(this._settings, 'changed::enabled', () => this._onToggled());
        this._connect(this._settings, 'changed::preview-border-width', () => {
            this._preview?.setBorderWidth(this._settings.get_int('preview-border-width'));
        });
        // 动态工作区：系统增删桌面之后索引会整体前移，回收一下状态
        this._connect(this._workspaceManager, 'workspace-added', () => this._store.prune());
        this._connect(this._workspaceManager, 'workspace-removed', () => this._store.prune());
        // 概览 / 应用网格关掉之后，把期间延后的摆窗口动作补上（见 _onShellIdle）
        if (typeof Main.overview?.connect === 'function')
            this._connect(Main.overview, 'hidden', () => this._onShellIdle());

        this._applySettingsToLayouts();
        this._startReevaluateTimer();

        // 用户把平铺关掉了（或者上一次 Shell 退出时是关着的）：什么都不做。
        // 尤其是**不能**去动 mutter 的 edge-tiling —— 那会让「关着平铺」的时候
        // 系统自带的贴边吸附也一起失效，而且因为设置没有变化，再也不会被恢复。
        if (this._settings.get_boolean('enabled'))
            this._resume(this._settings.get_boolean('rearrange-existing-windows'));
    }

    disable() {
        if (!this._enabled)
            return;
        this._enabled = false;
        this._cancelInteraction();
        this._stopReevaluateTimer();
        this._stopResizePoll();

        for (const id of this._timeoutSources)
            GLib.source_remove(id);
        this._timeoutSources.clear();

        for (const [object, id] of this._signalIds) {
            try {
                object.disconnect(id);
            } catch {
                // 对象可能已经销毁
            }
        }
        this._signalIds = [];

        for (const window of this._managed)
            this._untrackWindow(window);
        this._managed.clear();
        this._refs.clear();
        this._recency = [];
        this._internalMinimize.clear();
        this._internalUnminimize.clear();
        this._internalMaximize.clear();

        this._preview?.destroy();
        this._preview = null;
        this._restoreEdgeTiling();
        this._pendingRetile = false;
        this._pendingMaximizeCheck = false;
        this._evicted.clear();
        this._forgetDialogs();
        this._store.clear();
    }

    /* ------------------------------------------------ 供面板菜单 / 测试调用 */

    get store() {
        return this._store;
    }

    /** 按当前几何重新平铺所有被管理的窗口；adopt=true 时先接管漏掉的窗口。 */
    retileAll({adopt = false} = {}) {
        if (!this._enabled)
            return;
        if (adopt)
            this._adoptExistingWindows();
        for (const layout of this._store.entries()) {
            const area = this._areaFor(layout);
            if (!area || layout.tree.isEmpty)
                continue;
            layout.tree.layout(area);
            this._applyLayout(layout);
        }
    }

    /** 恢复所有被最小化（隐藏）的窗口，它们会顺次平铺进布局（需求 3）。 */
    restoreAllMinimized() {
        for (const layout of this._store.entries()) {
            for (const window of [...layout.minimized]) {
                if (window.minimized && this._managed.has(window))
                    window.unminimize();
            }
        }
    }

    /**
     * **预留接口**：把「最小化的窗口」拖到「未最小化的平铺窗口」上，交换两者的状态 ——
     * 拖过来的窗口在对方的格子里恢复成平铺窗口，对方被最小化（腾出的正是这个格子）。
     *
     * 为什么是「预留」：最小化的窗口在 GNOME 里只能在概览中拖动，而概览里的拖拽由
     * shell 自己处理、不会产生 mutter 的 grab-op，所以扩展现在接不到这次拖拽。
     * 这里先把语义、账本和布局变换准备好：将来把概览里的落点接上（或者从 Looking Glass、
     * 自动化脚本里调用）就只差一次调用。
     *
     * 交换之后两边的「原来位置」都记得住：拖过来的那个原本最小化时记下的位置作废
     * （它已经占住对方的格子），被最小化的那个记下它刚才的格子 —— 之后用户自己把它
     * 恢复出来时，会按需求 3 回到这里（和现在的窗口并排重新切开）。
     *
     * @param {Meta.Window} a 最小化的窗口或平铺窗口
     * @param {Meta.Window} b 另一个（顺序无所谓）
     * @returns {boolean} 是否真的交换了
     */
    swapWindowStates(a, b) {
        if (!this._enabled || !this._settings.get_boolean('enabled') || !a || !b || a === b)
            return false;
        if (!this._managed.has(a) || !this._managed.has(b))
            return false;

        const minimized = a.minimized ? a : b.minimized ? b : null;
        const tiled = minimized === a ? b : a;
        // 只能「一个最小化 + 一个平铺中的普通窗口」互换；两个都最小化 / 都平铺、
        // 或者对方是最大化 / 全屏，都不做（那些有自己的规则）
        if (!minimized || tiled.minimized || this._isActive(tiled))
            return false;

        const refA = this._refFor(a);
        const refB = this._refFor(b);
        if (refA.workspace !== refB.workspace || refA.monitorIndex !== refB.monitorIndex)
            return false;

        const layout = this._layoutFor(tiled);
        if (!layout || layout.paused || !layout.tree.findLeaf(tiled))
            return false;

        // 先记下平铺窗口此刻的位置（还原它时用），再把格子交给最小化的那个 ——
        // replaceWindow 只换叶子里的窗口，树的结构和尺寸都不变。
        this._rememberSpot(layout, tiled);
        if (!layout.tree.replaceWindow(tiled, minimized))
            return false;

        layout.minimized.delete(minimized);
        layout.preMinimize.delete(minimized);   // 它已经占住格子，旧位置作废
        layout.minimized.add(tiled);

        // 原平铺窗口：最小化（位置已经记过，_onMinimizedChanged 只做集合维护）
        this._internalMinimize.add(tiled);
        if (!tiled.minimized)
            tiled.minimize();

        // 最小化的那个：恢复成普通窗口（已经放进树里，_onMinimizedChanged 不用再安置）
        this._internalUnminimize.add(minimized);
        if (minimized.minimized)
            minimized.unminimize();

        layout.tree.layout(this._areaFor(layout));
        this._applyLayout(layout);
        this._verifyLater(minimized);
        this._log.log?.(`[codex-tiling] 交换窗口状态：${minimized.get_wm_class?.() ?? '?'} ` +
            `回到平铺，${tiled.get_wm_class?.() ?? '?'} 被最小化`);
        return true;
    }

    /**
     * 自动化测试钩子：等价于「把窗口拖到 (x, y) 后松手」。
     * 内部与真实拖动松手走的是同一条代码路径（需求 4）。
     */
    dropAt(window, x, y) {
        const layout = this._layoutFor(window);
        if (!layout || !layout.tree.findLeaf(window))
            return null;
        return this._applyDropPlan(window, layout, [x, y]);
    }

    /** 自动化测试钩子：开始一次手动缩放（等价于抓住边缘）。 */
    beginResize(window, edges = ['e']) {
        const layout = this._layoutFor(window);
        if (!layout || !layout.tree.findLeaf(window))
            return false;
        this._beginResize(window, layout, edges);
        this._startResizePoll();
        return true;
    }

    /** 自动化测试钩子：结束手动缩放（等价于松手）。 */
    endResize(window) {
        if (this._resize?.window !== window)
            return false;
        const {layout} = this._resize;
        this._resize = null;
        this._stopResizePoll();
        this._applyLayout(layout);
        return true;
    }

    /** 自动化测试钩子：按窗口当前几何提交一次边缘调整（需求 5）。 */
    commitResize(window, edges = ['e']) {
        const layout = this._layoutFor(window);
        if (!layout || !layout.tree.findLeaf(window))
            return false;
        this._resize = {window, layout, edges};
        this._onResizeProgress(window, edges);
        this._resize = null;
        this._applyLayout(layout);
        return true;
    }

    /* ------------------------------------------------------------ 窗口生命周期 */

    _onWindowCreated(window) {
        if (!this._enabled || !this._settings.get_boolean('enabled'))
            return;
        // 对话框：只登记「它是谁的对话框」，不平铺、也不去动父窗口
        this._watchDialog(window);
        if (!isTilableWindow(window))
            return;
        this._trackWindow(window);
        this._createdAt.set(window, this._now());
        this._rememberUserTime(window);
        this._idle(() => this._placeNewWindow(window));
    }

    /** 这个窗口是不是对话框 / 附属窗口（模态、文件选择器、工具窗……）。 */
    _isDialogWindow(window) {
        if (!window)
            return false;
        if (this._dialogs.has(window))
            return true;
        if (window.get_transient_for?.() ?? null)
            return true;
        const type = window.get_window_type?.() ?? Meta.WindowType.NORMAL;
        return type === Meta.WindowType.DIALOG || type === Meta.WindowType.MODAL_DIALOG;
    }

    /**
     * 登记对话框 → 父窗口的关系。
     *
     * 对话框弹出期间：**不重新平铺父窗口**（动父窗口会拽着对话框一起跳），
     * 也**不取消父窗口的最大化**（焦点落到对话框上不等于用户切走了）。
     * 对话框关掉之后再把父窗口放回它该在的格子里。
     */
    _watchDialog(window) {
        if (!window || isTilableWindow(window))
            return;
        const parent = window.get_transient_for?.() ?? null;
        if (!parent || this._dialogs.has(window))
            return;
        this._dialogs.set(window, parent);
        const id = window.connect('unmanaged', () => this._safely(() => this._onDialogClosed(window)));
        this._windowSignalIds.set(window, [id]);
    }

    /** 对话框关掉了：父窗口回到自己的格子（期间它一直没被改过）。 */
    _onDialogClosed(window) {
        const parent = this._dialogs.get(window) ?? null;
        this._dialogs.delete(window);
        const ids = this._windowSignalIds.get(window) ?? [];
        this._windowSignalIds.delete(window);
        for (const id of ids) {
            try {
                window.disconnect(id);
            } catch {
                // 窗口已经销毁，忽略
            }
        }
        if (!parent || !this._managed.has(parent) || parent.minimized)
            return;
        const layout = this._layoutFor(parent);
        if (layout && !layout.paused)
            this._applyLayout(layout);
        this._verifyLater(parent);
    }

    /** 这个窗口此刻有打开的对话框吗？ */
    _hasOpenDialog(window) {
        for (const [dialog, parent] of this._dialogs) {
            if (parent === window && !dialog.minimized)
                return true;
        }
        return false;
    }

    /** 断开并忘掉所有对话框登记（扩展停用 / 关闭平铺时）。 */
    _forgetDialogs() {
        for (const dialog of this._dialogs.keys()) {
            const ids = this._windowSignalIds.get(dialog) ?? [];
            this._windowSignalIds.delete(dialog);
            for (const id of ids) {
                try {
                    dialog.disconnect(id);
                } catch {
                    // 窗口已经销毁
                }
            }
        }
        this._dialogs.clear();
        this._selfGeometryPending.clear();
    }

    /** 需求 1 / 需求 2 */
    _placeNewWindow(window) {
        if (!this._enabled || !this._managed.has(window) || window.minimized)
            return;
        const layout = this._layoutFor(window);
        if (!layout || !this._areaFor(layout))
            return;

        // 需求 1：桌面上第一个窗口铺满整个工作区（通过 move_resize，而不是最大化）
        if (layout.tree.isEmpty) {
            layout.tree.setSingleWindow(window);
            this._applyLayout(layout);
            return;
        }

        // 需求 2（已改）：新窗口不再顶替焦点窗口，按通常的方式参与平铺 ——
        // 切开当前最大的格子、上下平铺进去。
        //
        // 如果桌面上原来有窗口处于最大化，那它的最大化在焦点切给新窗口时就已经
        // 被取消了（见 _dropMaximizeOnFocusChange），所以这里不需要再处理它。
        this._tileAtBottomLeft(window, layout);
    }

    _reevaluateLater(window, delay) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._timeoutSources.delete(id);
            this._safely(() => this._reevaluateWindow(window));
            return GLib.SOURCE_REMOVE;
        });
        this._timeoutSources.add(id);
    }

    /**
     * 定期复核所有在管的窗口：不再该参与平铺的（变成对话框、附属窗口、模态窗口……）
     * 就从布局里摘出去。
     *
     * 为什么需要主动复核：对话框的「附属」关系是**后来才建立**的。文件选择器
     * （尤其走 portal 的那种，窗口属于另一个进程）先以普通窗口出现，过一会儿才把
     * 父窗口接上；mutter 这边 `transient-for` 不是 GObject 属性、没有
     * notify::transient-for 可听。所以除了事件驱动（窗口类型变化、焦点变化），
     * 还要有一个低成本的兜底轮询。
     */
    _startReevaluateTimer() {
        if (this._reevaluateTimer)
            return;
        this._reevaluateTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
            if (!this._enabled) {
                this._reevaluateTimer = 0;
                return GLib.SOURCE_REMOVE;
            }
            this._safely(() => {
                for (const window of [...this._managed])
                    this._reevaluateWindow(window);
                this._recheckEvicted();
            });
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopReevaluateTimer() {
        if (!this._reevaluateTimer)
            return;
        GLib.source_remove(this._reevaluateTimer);
        this._reevaluateTimer = 0;
    }

    /** 复核一个窗口；如果它已经不该参与平铺，就把它摘出去。返回是否摘掉了。 */
    _reevaluateWindow(window) {
        if (!this._enabled || !this._managed.has(window))
            return false;
        if (isTilableWindow(window))
            return false;
        const layout = this._layoutFor(window);
        if (!layout)
            return false;
        this._evictFromTiling(window, layout);
        return true;
    }

    /**
     * 重新接管一个不在管的窗口（例如刚从全屏退出来、或者被旧版本误驱逐过的）。
     * 只接管真正该平铺的窗口，对话框之类原样不动。
     */
    _readoptWindow(window) {
        if (!this._enabled || this._managed.has(window) || !isTilableWindow(window))
            return false;
        if (!this._settings.get_boolean('enabled'))
            return false;
        this._log.debug?.(`[codex-tiling] 重新接管 ${window.get_wm_class?.() ?? '?'}（退出全屏 / 取消最大化）`);
        this._trackWindow(window);
        this._evicted.delete(window);
        this._createdAt.set(window, this._now());
        this._rememberUserTime(window);
        this._idle(() => this._placeNewWindow(window));
        return true;
    }

    /** 把窗口从平铺里摘出去：移除它的格子、其余窗口吸收空间，之后不再管它。 */
    _evictFromTiling(window, layout) {
        this._log.debug?.(`[codex-tiling] ${window.get_wm_class?.() ?? '?'} 变成浮动窗口，退出平铺`);
        this._evicted.add(window);
        this._untrackWindow(window);
        layout.minimized.delete(window);
        layout.preMinimize.delete(window);
        if (layout.maximized === window) {
            layout.maximized = null;
            layout.paused = false;
        }
        if (this._removeFromTree(layout, window, {equalizeRows: true})) {
            const area = this._areaFor(layout);
            if (area)
                layout.tree.layout(area);
            this._applyLayout(layout);
        }
        this._forgetIfEmpty(layout);
    }

    /**
     * 回看被摘出平铺的窗口：退出全屏、取消最大化之后，或者当初那一下子判断错了
     * （典型例子：全屏退出的瞬间 mutter 还认为它「跟屏幕一样大」），都要能回到平铺。
     */
    _recheckEvicted() {
        if (!this._evicted.size)
            return;
        let alive = null;
        for (const window of [...this._evicted]) {
            if (!alive)
                alive = new Set(this._display.list_all_windows());
            if (!alive.has(window)) {
                this._evicted.delete(window);
                continue;
            }
            if ((window.is_fullscreen?.() ?? false) || window.minimized || !isTilableWindow(window))
                continue;
            if (this._readoptWindow(window))
                this._evicted.delete(window);
        }
    }

    /**
     * 只把某一个窗口放进它此刻应该在的格子里。
     * 布局被最大化窗口冻住时用它：其它窗口保持原样，但新来的窗口不能不落位。
     */
    _placeInLayout(layout, window) {
        if (this._shellBusy()) {
            this._pendingRetile = true;   // 概览关掉之后再补
            return;
        }
        const area = this._areaFor(layout);
        if (!area || !layout.tree.findLeaf(window) || window.minimized)
            return;
        layout.tree.layout(area);
        const rect = layout.tree.rectFor(window);
        if (rect)
            this._applyRect(window, rect);
    }

    /**
     * 记下窗口被最小化之前的位置。
     *
     * 平铺树里一个窗口消失时，它腾出的空间会被**兄弟子树**吸收，所以只要记住
     * 那个兄弟节点、以及当时的分割方向与比例，还原时把它按同样的方式切开，
     * 就能精确回到最小化之前的样子（兄弟子树也一起回到原来的大小）。
     */
    _rememberSpot(layout, window) {
        const leaf = layout.tree.findLeaf(window);
        const parent = leaf?.parent;
        if (!leaf || !parent)
            return;
        const wasFirst = parent.first === leaf;
        layout.preMinimize.set(window, {
            siblingId: (wasFirst ? parent.second : parent.first).id,
            wasFirst,
            orientation: parent.orientation,
            ratio: parent.ratio,
        });
    }

    /** 需求 3：用户自己最小化的窗口还原回原位；做不到时退回到「与最左下窗口上下平铺」。 */
    _restoreWindow(window) {
        const layout = this._layoutFor(window);
        const area = this._areaFor(layout);
        if (!layout || !area)
            return;

        if (!layout.tree.isEmpty)
            layout.tree.layout(area);

        // 有最大化窗口时先取消最大化，否则恢复出来的窗口无处安放
        if (layout.maximized) {
            const maximized = layout.maximized;
            layout.maximized = null;
            layout.paused = false;
            this._unmaximizeInternal(maximized);
        }

        // 还原的窗口一律「从左下开始平铺」：切开左下角那个窗口的格子，
        // 和它上下均分（不再回到最小化之前记住的那个位置）
        layout.preMinimize.delete(window);
        const columnsBefore = layout.tree.columnCount();
        this._splitBottomLeft(layout.tree, window);

        layout.minimized.delete(window);
        // 这一栏多了一行 → 行高均分；如果还原还多出一整栏，分栏等宽
        if (layout.tree.findLeaf(window))
            this._equalizeColumnOfWindow(layout, window);
        if (layout.tree.columnCount() !== columnsBefore)
            layout.tree.equalizeColumns();
        this._applyLayout(layout);
        this._verifyLater(window);   // 最小化 / 还原的几何同样可能是异步恢复的
    }

    /** 布局里最靠下的窗口（并列时取最靠左的），也就是需求 3 里的「最左下」窗口。 */
    _bottomLeftLeaf(tree) {
        let best = null;
        let bestRect = null;
        for (const leaf of tree.leaves()) {
            const rect = tree.nodeRect(leaf);
            if (!rect)
                continue;
            if (!best) {
                best = leaf;
                bestRect = rect;
                continue;
            }
            const bottom = rect.y + rect.height;
            const bestBottom = bestRect.y + bestRect.height;
            if (bottom > bestBottom || (bottom === bestBottom && rect.x < bestRect.x)) {
                best = leaf;
                bestRect = rect;
            }
        }
        return best;
    }

    /**
     * 把一个新加入平铺的窗口安置好：切开「最左下」那个窗口的格子，新窗口占它的下半部分
     * —— 于是新窗口从**左下角**开始长出来，其它窗口的矩形一动不动。
     */
    _tileAtBottomLeft(window, layout) {
        const area = this._areaFor(layout);
        if (!area)
            return;
        layout.tree.layout(area);
        this._splitBottomLeft(layout.tree, window);
        // 一个分栏里的窗口数变了 → 这一栏的行高均分（新增窗口也不例外）
        if (layout.tree.findLeaf(window))
            this._equalizeColumnOfWindow(layout, window);
        layout.minimized.delete(window);
        // 布局被最大化窗口冻住时，至少把这个新窗口放进它自己的格子
        if (layout.maximized && layout.maximized !== window)
            this._placeInLayout(layout, window);
        else
            this._applyLayout(layout);
    }

    /**
     * 从布局里移除一个窗口；如果因此**少掉了一整列**，把剩下的分栏重新均分
     * （「删除分栏时也等宽」）。只是关掉某一列里的一行时不动宽度 ——
     * 免得把用户手动拖出来的列宽抹掉。
     */
    /**
     * 从布局里移除一个窗口；少掉一整列时把剩下的分栏重新均分（删除分栏时也等宽）。
     *
     * `equalizeRows` 只给「关闭窗口 / 窗口退出平铺」用：这一栏还有剩下的行时把行高
     * 重新均分。最小化不用它（最小化的窗口要按原位置还原），换桌面也不用。
     */
    _removeFromTree(layout, window, {equalizeRows = false} = {}) {
        // 摘之前先记下它所在的「分栏」和那一栏里的其它窗口：只剩一行时整栏会消失，
        // 还有多行时要把剩下的行高重新均分
        const leaf = equalizeRows ? layout.tree.findLeaf(window) : null;
        const column = leaf ? layout.tree.columnRegion(leaf) : null;
        const columnWindows = column
            ? layout.tree.windows().filter(w => this._windowInNode(layout.tree, column, w))
            : [];

        const columnsBefore = layout.tree.columnCount();
        const removed = layout.tree.removeWindow(window);
        if (!removed)
            return false;
        if (layout.tree.columnCount() < columnsBefore) {
            layout.tree.equalizeColumns();
            return true;
        }
        if (equalizeRows) {
            // 只是少了一行：把这一栏剩下的行高均分
            const survivor = columnWindows.find(w => w !== window && layout.tree.findLeaf(w));
            if (survivor)
                this._equalizeColumnOfWindow(layout, survivor);
        }
        return true;
    }

    /** 某个窗口是不是在给定子树里。 */
    _windowInNode(tree, node, window) {
        if (!node)
            return false;
        if (node.kind === 'leaf')
            return node.window === window;
        return this._windowInNode(tree, node.first, window) ||
            this._windowInNode(tree, node.second, window);
    }

    /** 把 window 所在那一栏的行高均分（别的分栏不动）。 */
    _equalizeColumnOfWindow(layout, window) {
        const area = this._areaFor(layout);
        if (!area)
            return;
        layout.tree.layout(area);
        const leaf = layout.tree.findLeaf(window);
        if (!leaf)
            return;
        const column = layout.tree.columnRegion(leaf);
        if (!column || column.kind === 'leaf')
            return;
        layout.tree.equalizeRows(column);
    }

    /** 某个窗口所在那一栏里一共有哪些窗口（窗口不在布局里时返回空）。 */
    _columnWindowsOf(layout, window) {
        const leaf = layout.tree.findLeaf(window);
        if (!leaf)
            return [];
        const column = layout.tree.columnRegion(leaf);
        return layout.tree.windows()
            .filter(w => this._windowInNode(layout.tree, column, w));
    }

    /** 把窗口放进「最左下」那个窗口的下半部分（布局为空时独占整块）。 */
    _splitBottomLeft(tree, window) {
        const anchor = tree.isEmpty ? null : this._bottomLeftLeaf(tree);
        if (anchor) {
            // 上下堆叠：不自己切出新分栏 —— 分栏只在用户明确把窗口拖到别的窗口
            // 左/右边时才产生
            tree.splitLeafNode(anchor, window, {before: false, ratio: 0.5, orientation: 'v'});
        } else {
            tree.setSingleWindow(window);
        }
    }

    _onMinimizedChanged(window) {
        if (!this._enabled || !this._managed.has(window))
            return;
        const layout = this._layoutFor(window);
        if (!layout)
            return;

        if (window.minimized) {
            const internal = this._internalMinimize.delete(window);
            layout.minimized.add(window);
            if (layout.maximized === window) {
                layout.maximized = null;
                layout.paused = false;
            }
            if (!internal) {
                // 用户自己最小化的：记下它原本的位置，还原时按原样放回去
                this._rememberSpot(layout, window);
                // 这一栏少了一行 → 剩下的行高均分（还原时会再均分一次）
                this._removeFromTree(layout, window, {equalizeRows: true});
            }
            layout.tree.layout(this._areaFor(layout));
            this._applyLayout(layout);
            this._forgetIfEmpty(layout);
            this._maybeShowOverview();
            return;
        }

        layout.minimized.delete(window);
        if (this._internalUnminimize.delete(window))
            return;
        if (layout.tree.findLeaf(window))
            return;
        this._restoreWindow(window); // 需求 3
    }

    /** 需求 6：通常的最大化行为 + 每桌面至多一个最大化窗口 */
    _onMaximizeChanged(window) {
        if (!this._enabled)
            return;
        if (!this._managed.has(window)) {
            // 退出全屏 / 取消最大化的这个瞬间，如果它根本没在被管（曾被误判成
            // 「不该平铺」而驱逐，或者经历过旧版本的 bug），就趁现在重新接管 ——
            // 否则它会一直停在原地，再也不参与平铺。
            if (!(window.is_fullscreen?.() ?? false) &&
                (window.get_maximize_flags?.() ?? 0) === 0)
                this._readoptWindow(window);
            return;
        }
        const layout = this._layoutFor(window);
        if (!layout)
            return;

        if (this._isActive(window)) {
            // 我们自己调用的 unmaximize/maximize 不再触发递归
            if (this._internalMaximize.delete(window))
                return;
            // 新窗口自己带着最大化状态出现（应用主动最大化 / mutter 放的）：
            // 需求 6 —— 只有它正在取代那个最大化窗口时才保留最大化，
            // 否则先取消最大化，让它按普通窗口落位（否则布局会被错误地冻住）
            if (layout.maximized === window) {
                // 已经登记为这个桌面的最大化窗口（也可能是我们刚让它「接着最大化」的）
                layout.paused = true;
                return;
            }
            if (this._isSelfMaximize(window)) {
                // 「下一个窗口先取消最大化再进行平铺」（需求 6）
                this._internalMaximize.add(window);
                this._unmaximizeWindow(window);
                return;
            }

            const previous = layout.maximized;
            layout.maximized = window;
            layout.paused = true;
            if (previous && previous !== window) {
                this._unmaximizeInternal(previous);
                const rect = layout.tree.rectFor(previous);
                if (rect)
                    this._applyRect(previous, rect);
            }
            return;
        }

        if (layout.maximized === window) {
            layout.maximized = null;
            layout.paused = false;
            // 拖动 / 缩放中取消最大化时交给落点逻辑处理，避免窗口被拽回去
            if (this._drag?.window === window || this._resize?.window === window)
                return;
            // 需求 6：恢复最大化之前的布局
            if (!layout.tree.findLeaf(window))
                this._tileAtBottomLeft(window, layout);
            else
                this._applyLayout(layout);
            // mutter 可能稍后才把「最大化前的几何」恢复过来：只针对这一个窗口
            // 稍后核对一次（复核自带「已经在位就不动」的判断，不会白动窗口）
            this._verifyLater(window);
        }
    }

    /** 需求 7：窗口被移动到别的工作区 / 显示器 */
    _onRelocate(window) {
        if (!this._enabled || !this._managed.has(window))
            return;
        this._idle(() => this._relocate(window));
    }

    _relocate(window) {
        if (!this._enabled || !this._managed.has(window))
            return;
        const previous = this._refs.get(window);
        const next = this._refFor(window);
        if (previous &&
            previous.workspace === next.workspace &&
            previous.monitorIndex === next.monitorIndex)
            return;

        if (this._drag?.window === window)
            this._cancelInteraction();

        // 先离开旧布局，剩下的窗口吸收它腾出来的空间
        const oldLayout = previous
            ? this._store.get(previous.workspace, previous.monitorIndex)
            : null;
        if (oldLayout) {
            oldLayout.minimized.delete(window);
            oldLayout.preMinimize.delete(window);
            if (oldLayout.maximized === window) {
                oldLayout.maximized = null;
                oldLayout.paused = false;
            }
            // 拖到别的工作区 / 显示器 = 从原来那一栏里拖出去：剩下一栏的行高均分
            if (this._removeFromTree(oldLayout, window, {equalizeRows: true})) {
                const oldArea = this._areaFor(oldLayout);
                if (oldArea)
                    oldLayout.tree.layout(oldArea);
                this._applyLayout(oldLayout);
            }
            this._forgetIfEmpty(oldLayout);
            this._maybeShowOverview();
        }

        this._refs.set(window, next);
        const layout = this._store.get(next.workspace, next.monitorIndex, this._layoutDefaults());
        const area = this._areaFor(layout);
        if (!layout || !area)
            return;
        layout.tree.layout(area);

        // 需求 7：最小化的窗口挪过去仍然保持最小化 —— 它不参与目标桌面的平铺，
        // 目标桌面的其它窗口照常
        if (window.minimized) {
            layout.minimized.add(window);
            this._applyLayout(layout);
            this._maybeShowOverview();
            return;
        }

        // 需求 7：最大化的窗口（含全屏）挪过去仍然保持最大化，并接管那个桌面的
        // 「最大化位置」（那边原先最大化的窗口让位、回到自己的格子）
        if (this._isActive(window)) {
            const previousMax = layout.maximized;
            if (previousMax && previousMax !== window) {
                this._unmaximizeInternal(previousMax);
                const rect = layout.tree.rectFor(previousMax);
                if (rect)
                    this._applyRect(previousMax, rect);
            }
            this._takeOverMaximizedSlot(layout, window);
            return;
        }

        // 普通窗口：空白桌面 → 按需求 1 铺满；非空白桌面 → 一起参与平铺
        if (layout.tree.isEmpty) {
            layout.minimized.delete(window);
            layout.tree.setSingleWindow(window);
            this._applyLayout(layout);
            return;
        }

        // 加入目标桌面的平铺：切开当前最大的格子放进去（不抢走别人的位置、
        // 也不把别人最小化）。桌面上正有窗口最大化时它先落在自己的格子里，等焦点过去
        // 再跟着最大化（「最大化跟着焦点走」）。
        layout.minimized.delete(window);
        this._tileAtBottomLeft(window, layout);
    }

    _onUnmanaged(window) {
        const previous = this._refs.get(window);
        this._untrackWindow(window);
        if (!previous)
            return;
        const layout = this._store.get(previous.workspace, previous.monitorIndex);
        if (!layout) {
            this._store.prune();
            return;
        }
        layout.minimized.delete(window);
        layout.preMinimize.delete(window);
        // 关掉的是不是「当前处于最大化」的那个窗口？—— 它的位置会交还给被它顶替掉的
        // 上一个窗口，但最大化状态不跟着走：那个窗口以普通平铺窗口的身份回来
        const wasMaximized = layout.maximized === window;

        if (wasMaximized) {
            layout.maximized = null;
            layout.paused = false;
        }
        if (this._removeFromTree(layout, window, {equalizeRows: true})) {
            const area = this._areaFor(layout);
            if (area)
                layout.tree.layout(area);
        }
        this._applyLayout(layout);
        this._forgetIfEmpty(layout);
        this._maybeShowOverview();
    }

    /**
     * 桌面上的窗口全都消失后，「最大化位置」这样的状态也就没有意义了；
     * 同时回收空布局，避免状态随着工作区增删无限增长。
     */
    _forgetIfEmpty(layout) {
        if (layout.tree.isEmpty && layout.minimized.size === 0 && !layout.maximized)
            layout.paused = false;
        this._store.prune();
    }

    _onFocusChanged() {
        const window = this._display.get_focus_window();
        if (!window)
            return;
        this._recency = [window, ...this._recency.filter(w => w !== window)].slice(0, 50);
        this._idle(() => this._dropMaximizeOnFocusChange());
        // 文件选择器这类窗口一出现往往就拿到焦点，此刻复核一次，
        // 稍后再补一次（它的父窗口关系可能是异步接上的）
        this._idle(() => this._reevaluateWindow(window));
        this._reevaluateLater(window, 400);
        this._reevaluateLater(window, 1200);
    }

    /**
     * 从最大化的窗口切到同一桌面上的另一个窗口时，**只取消原来那个窗口的最大化**：
     * 它回到自己的格子、布局恢复；新聚焦的窗口保持普通平铺，不会被带着一起最大化。
     *
     * 跨桌面切换不动（每个桌面各有一份布局）；拖动 / 缩放过程中不动（避免和指针操作打架）；
     * 全屏窗口不参与（它是另一回事：视频、演示、游戏）。
     */
    _dropMaximizeOnFocusChange() {
        if (!this._enabled || this._drag || this._resize)
            return;
        if (this._shellBusy()) {
            // 在概览里切换窗口：等概览关掉再处理，否则「切走就取消最大化」永远不会执行
            this._pendingMaximizeCheck = true;
            return;
        }
        const window = this._display.get_focus_window();
        if (!window)
            return;
        // 焦点落在对话框上（父窗口的模态框、文件选择器……）：这不是「用户切走了」，
        // 原来那个最大化的父窗口保持最大化，也不去重新平铺它
        if (this._isDialogWindow(window))
            return;
        const layout = this._layoutFor(window);
        const previous = layout?.maximized;
        if (!layout || !previous || previous === window)
            return;
        if (previous.is_fullscreen?.() ?? false)
            return;
        const ref = this._refFor(window);
        if (layout.workspace !== ref.workspace || layout.monitorIndex !== ref.monitorIndex)
            return;

        this._unmaximizeInternal(previous);
        layout.maximized = null;
        layout.paused = false;
        if (!layout.tree.findLeaf(previous)) {
            // 它是从别的桌面挪进来、当时只登记成「这个桌面的最大化窗口」而没有格子：
            // 现在它不再最大化，就得按通常方式插进布局，否则会一直飘在外面
            this._tileAtBottomLeft(previous, layout);
        } else {
            const rect = layout.tree.rectFor(previous);
            if (rect)
                this._applyRect(previous, rect);
            this._applyLayout(layout);
        }
        this._verifyLater(previous);
    }

    /* -------------------------------------------------------------- 拖动窗口 */

    _onGrabBegin(window, op) {
        if (!this._enabled || !this._settings.get_boolean('enabled'))
            return;
        if (!this._managed.has(window))
            return;
        const layout = this._layoutFor(window);
        if (!layout)
            return;

        if (MOVE_OPS.includes(op)) {
            // 最大化窗口被拖走时 mutter 会自动取消最大化，此时按普通窗口处理
            this._drag = {window, layout};
            this._updateDragPreview();
            return;
        }

        const edges = this._resizeEdgesForOp(op);
        if (edges.length) {
            this._beginResize(window, layout, edges);
            this._startResizePoll();
        }
    }

    /** 把 grab op 认成「哪些边在被拖动」；认不出来时用低位兜底（不同 mutter 版本带不同的标志位）。 */
    _resizeEdgesForOp(op) {
        const exact = RESIZE_EDGES.get(op);
        if (exact)
            return exact;
        const base = op & 0x0f;
        for (const [known, edges] of RESIZE_EDGES) {
            if ((known & 0x0f) === base && base >= 2)
                return edges;
        }
        return [];
    }

    /**
     * 开始一次手动缩放：记下抓取瞬间的指针位置，以及**布局里那条分界线**与指针的偏移。
     *
     * 之后边界完全由**指针位置**推算（指针坐标 + 偏移），不再等客户端的几何确认 ——
     * 交互式缩放时窗口的新尺寸是异步生效的，等它会让边界永远慢一拍，看起来就是抽搐。
     *
     * 偏移以「布局里这个窗口的格子边缘」为基准，而不是窗口此刻的实际边缘：客户端的
     * 实际尺寸可能和格子不一致（尺寸限制、刚被摆进去还没生效……），
     * 以它为基准会让分界线在抓取的一瞬间跳到别处，连累到相隔很远的窗口。
     * 用格子边缘做基准，抓取瞬间的分界线正好等于布局现在的边界（不会动），
     * 之后就是 1:1 跟着指针走。
     */
    _beginResize(window, layout, edges) {
        const area = this._areaFor(layout);
        if (area)
            layout.tree.layout(area);
        const anchor = layout.tree.rectFor(window) ?? this._frameRect(window);
        const [px, py] = global.get_pointer();
        this._resize = {
            window, layout, edges,
            offset: {
                e: anchor ? anchor.x + anchor.width - px : 0,
                w: anchor ? anchor.x - px : 0,
                s: anchor ? anchor.y + anchor.height - py : 0,
                n: anchor ? anchor.y - py : 0,
            },
            /** 上一次给每条边算出的边界值：用来挡住离谱的指针采样（见 MAX_POINTER_STEP）。 */
            last: {},
        };
        const anchorText = anchor
            ? `${Math.round(anchor.x)},${Math.round(anchor.y)} ` +
              `${Math.round(anchor.width)}x${Math.round(anchor.height)}`
            : '（没有格子）';
        this._log.debug?.(`[codex-tiling] 开始缩放 ${window.get_wm_class?.() ?? '?'} ` +
            `边=${edges.join('')} 指针=(${Math.round(px)},${Math.round(py)}) 基准=${anchorText}`);
        this._onResizeProgress(window, edges, [px, py]);
    }

    /** 缩放期间按帧轮询指针：每帧把边界推到位，其它窗口跟着联动。 */
    _startResizePoll() {
        if (this._resizeTimer)
            return;
        this._resizeTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RESIZE_POLL_MS, () => {
            const resize = this._resize;
            if (!this._enabled || !resize) {
                this._resizeTimer = 0;
                return GLib.SOURCE_REMOVE;
            }
            this._safely(() => {
                const [px, py] = global.get_pointer();
                this._onResizeProgress(resize.window, resize.edges, [px, py]);
            });
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopResizePoll() {
        if (!this._resizeTimer)
            return;
        GLib.source_remove(this._resizeTimer);
        this._resizeTimer = 0;
    }

    _onGrabEnd(window, op) {
        if (this._drag?.window === window) {
            const drag = this._drag;
            this._drag = null;
            this._preview?.hide();
            if (MOVE_OPS.includes(op))
                this._commitDrop(drag);
            return;
        }
        if (this._resize?.window === window) {
            const {layout, edges} = this._resize;
            this._resize = null;
            this._stopResizePoll();
            const cell = layout.tree.rectFor(window);
            this._log.debug?.(`[codex-tiling] 结束缩放 ${window.get_wm_class?.() ?? '?'} ` +
                `边=${edges.join('')} 落位=${cell ? `${Math.round(cell.x)},${Math.round(cell.y)} ` +
                `${Math.round(cell.width)}x${Math.round(cell.height)}` : 'null'}`);
            this._applyLayout(layout); // 松手后精确对齐（需求 5）
        }
    }

    _onPositionChanged(window) {
        if (!this._enabled)
            return;
        if (this._drag?.window === window) {
            this._updateDragPreview();
            return;
        }
        // 窗口自己挪了位置：让布局跟着它
        this._scheduleSelfGeometry(window);
    }

    _onSizeChanged(window) {
        if (!this._enabled)
            return;
        // 手动缩放期间边界由指针轮询驱动（见 _startResizePoll）：客户端几何是异步
        // 确认的，跟着它走会让边界慢一拍。没有轮询时（程序化调整）用一次兜底提交。
        if (this._resize?.window === window) {
            if (!this._resizeTimer)
                this._onResizeProgress(window, this._resize.edges);
            return;
        }
        // 窗口自己改了尺寸：让布局跟着它调整
        this._scheduleSelfGeometry(window);
    }

    /** 窗口自主改变几何（不是我们摆的、也不是鼠标拖的）：攒到本轮空闲再处理。 */
    _scheduleSelfGeometry(window) {
        if (!this._enabled || !this._managed.has(window) || this._selfGeometryPending.has(window))
            return;
        this._selfGeometryPending.add(window);
        this._idle(() => {
            this._selfGeometryPending.delete(window);
            this._safely(() => this._absorbSelfGeometry(window));
        });
    }

    /**
     * 窗口自己调整了位置 / 尺寸（程序化 resize、视频切换比例、终端改行列……）：
     * 把它的格子改成新的矩形，由邻近窗口吸收差值 —— 不再把它拽回原来的格子。
     *
     * 只处理「和当前格子对不上」的边；每条边都走级联（见 _cascadeResize），
     * 邻近窗口被压到最小尺寸时由再外面那个窗口接着让。
     */
    _absorbSelfGeometry(window) {
        if (!this._enabled || !this._managed.has(window) || window.minimized)
            return;
        if (this._drag || this._resize || this._shellBusy())
            return;
        if (this._hasOpenDialog(window))
            return;
        // 刚写过、客户端没照做：那是「拒绝」，由复核 / 迁就那条路径处理
        if ((this._writeGuardUntil.get(window) ?? 0) > this._now())
            return;
        const layout = this._layoutFor(window);
        const area = this._areaFor(layout);
        if (!layout || !area || layout.paused || !layout.tree.findLeaf(window))
            return;
        if ((window.get_maximize_flags?.() ?? 0) !== 0 || (window.is_fullscreen?.() ?? false))
            return;

        layout.tree.layout(area);
        const cell = layout.tree.rectFor(window);
        const rect = this._frameRect(window);
        if (!cell || !rect)
            return;
        const wanted = {
            w: Math.round(rect.x),
            e: Math.round(rect.x + rect.width),
            n: Math.round(rect.y),
            s: Math.round(rect.y + rect.height),
        };
        const current = {
            w: cell.x,
            e: cell.x + cell.width,
            n: cell.y,
            s: cell.y + cell.height,
        };
        const edges = ['w', 'e', 'n', 's']
            .filter(edge => Math.abs(wanted[edge] - current[edge]) > 1);
        if (!edges.length)
            return;

        let moved = false;
        for (const edge of edges) {
            layout.tree.layout(area);
            if (this._cascadeResize(layout, window, edge, wanted[edge]))
                moved = true;
        }
        if (!moved)
            return;
        layout.tree.layout(area);
        // 窗口自己的新几何保留；只把邻居摆到它们的新格子里
        this._applyLayout(layout, {skip: new Set([window])});
        this._log.debug?.(`[codex-tiling] 跟随窗口自己的几何变化 ${window.get_wm_class?.() ?? '?'}：` +
            `${Math.round(rect.width)}x${Math.round(rect.height)} @ ` +
            `${Math.round(rect.x)},${Math.round(rect.y)}`);
    }

    _updateDragPreview() {
        const drag = this._drag;
        if (!drag || !this._enabled)
            return;
        const {window, layout} = drag;
        const area = this._areaFor(layout);
        if (!area || !layout.tree.findLeaf(window))
            return;

        layout.tree.layout(area);
        const [x, y] = global.get_pointer();
        const plan = this._planFor(window, layout, [x, y]);
        drag.plan = plan;

        if (plan.action === DROP_NONE || !this._settings.get_boolean('show-preview')) {
            this._preview?.hide();
            return;
        }
        if (!this._preview)
            this._preview = new DropPreview();
        const preview = this._previewFor(plan);
        if (preview) {
            this._preview.show(preview.rect, {
                gap: preview.gap,
                borderWidth: this._settings.get_int('preview-border-width'),
            });
        }
    }

    /**
     * 这个落点该画成什么：
     *   · 插入型（两个窗口之间 / 贴边插入 / 贴到屏幕边缘）→ 画那条**间隙**（细长条）；
     *   · 铺满空桌面、交换位置 → 画目标格子。
     */
    _previewFor(plan) {
        if (!plan || plan.action === DROP_NONE)
            return null;
        if (plan.gapRect)
            return {rect: plan.gapRect, gap: true};
        return plan.previewRect ? {rect: plan.previewRect, gap: false} : null;
    }

    _commitDrop(drag) {
        const {window, layout} = drag;
        if (!this._enabled || !this._managed.has(window) || window.minimized)
            return;

        // 拖到了别的显示器 / 工作区：交给需求 7 的规则处理
        const ref = this._refFor(window);
        if (ref.monitorIndex !== layout.monitorIndex || ref.workspace !== layout.workspace)
            return;

        const [x, y] = global.get_pointer();
        this._applyDropPlan(window, layout, [x, y]);
    }

    /** 需求 4 的执行部分；预览与真实落点都用它，保证两者一致。 */
    _applyDropPlan(window, layout, pointer) {
        const area = this._areaFor(layout);
        if (!area)
            return null;
        if (!layout.tree.findLeaf(window)) {
            // 它不在布局里（例如刚被挪进来的最大化窗口还没有格子）：先按普通窗口安置
            layout.tree.layout(area);
            this._tileAtBottomLeft(window, layout);
            return null;
        }
        layout.tree.layout(area);

        const plan = this._planFor(window, layout, pointer);
        if (plan.action === DROP_NONE) {
            this._applyLayout(layout); // 回到原本的格子
            return plan;
        }

        // 拖动前它所在的那一栏：被拖出去（列数 / 行数变了）之后，剩下的行高均分
        const beforeColumnWindows = this._columnWindowsOf(layout, window);
        const beforeLeaf = layout.tree.findLeaf(window);
        const beforeColumn = beforeLeaf ? layout.tree.columnRegion(beforeLeaf) : null;
        const columnsBefore = layout.tree.columnCount();

        // 拖动最大化窗口并放在某处，等于把它变回平铺窗口
        if (layout.maximized === window) {
            layout.maximized = null;
            layout.paused = false;
        }

        layout.tree = plan.tree;
        // 分栏数量变了（新增 / 消失一整栏）→ 所有分栏等宽
        if (layout.tree.columnCount() !== columnsBefore)
            layout.tree.equalizeColumns();
        // 在某一栏的两个窗口之间插入新行 → 这一栏的行高均分（新增分栏仍然是等宽，
        // 由 planDrop / equalizeColumns 负责）。普通「新开一个窗口」不走这里，
        // 仍然由邻近窗口让出一半空间。
        if (this._planInsertedRow(plan))
            this._equalizeColumnOfWindow(layout, window);
        // 被拖出原来那一栏：那一栏少了一行 → 剩下各行的高度均分
        if (beforeColumn && beforeColumnWindows.length > 1) {
            for (const other of beforeColumnWindows) {
                if (other === window || !layout.tree.findLeaf(other))
                    continue;
                // 交换位置时两边行数都没变，不该抹掉用户手动拖出来的行高
                if (this._columnWindowsOf(layout, other).length < beforeColumnWindows.length)
                    this._equalizeColumnOfWindow(layout, other);
                break;
            }
        }
        this._applyLayout(layout);
        return plan;
    }

    /** 这个落点计划是不是「在某一栏里插入新的一行」。 */
    _planInsertedRow(plan) {
        if (!plan || !plan.detail)
            return false;
        if (plan.action === DROP_BETWEEN)
            return plan.detail.column === false;
        if (plan.action === DROP_EDGE)
            return plan.detail.unit === 'row';
        return false;
    }

    _planFor(window, layout, pointer) {
        return planDrop({
            tree: layout.tree,
            window,
            pointer,
            threshold: this._settings.get_int('edge-threshold'),
            // 两种预览共用同一个「边框像素」
            gapThickness: this._settings.get_int('preview-border-width'),
        });
    }

    /* -------------------------------------------------------------- 尺寸联动 */

    _onResizeProgress(window, edges, pointer = null) {
        const resize = this._resize;
        if (!resize || resize.window !== window)
            return;
        const {layout} = resize;
        const area = this._areaFor(layout);
        if (!area || !layout.tree.findLeaf(window))
            return;

        // 四角拖动（mutter 会同时给出两个方向，例如 'se'）就**同时**调整宽度和高度：
        // 每条边各自走「只动相邻两块、到最小就停」的规则，两者互不打架。
        const activeEdges = edges;
        if (!activeEdges.length)
            return;

        const rect = this._frameRect(window);
        let changed = false;
        for (const edge of activeEdges) {
            layout.tree.layout(area); // setEdge() 依赖缓存下来的几何
            // 有指针（真实拖动）就用指针推：不依赖客户端什么时候确认新尺寸；
            // 没有指针（程序化调整 / 测试钩子）就按窗口当前几何算
            let value = pointer
                ? (edge === 'e' || edge === 'w' ? pointer[0] : pointer[1]) + resize.offset[edge]
                : edge === 'e' ? rect.x + rect.width
                    : edge === 'w' ? rect.x
                        : edge === 's' ? rect.y + rect.height
                            : rect.y;
            if (pointer) {
                const last = resize.last[edge];
                if (Number.isFinite(last) && Math.abs(value - last) > MAX_POINTER_STEP) {
                    // 指针读数一帧之内跳了这么远，多半是坏采样（主循环卡顿、坐标没更新）。
                    // 只挪一小步，下一帧再继续追 —— 直接采信会让分界线一步弹到极端位置
                    this._log.debug?.(`[codex-tiling] 缩放指针采样异常：${edge} 边 ` +
                        `${Math.round(last)} → ${Math.round(value)}，本帧只走 ${MAX_POINTER_STEP}px`);
                    value = last + Math.sign(value - last) * MAX_POINTER_STEP;
                }
                resize.last[edge] = value;
            }
            // 用「按位移」的版本：只有紧挨着这条边的两个分栏改变尺寸，
            // 同一子树里的其它窗口（例如「左中右」里最左边那一列）一点不动
            if (this._cascadeResize(layout, window, edge, value))
                changed = true;
        }
        if (!changed)
            return;

        layout.tree.layout(area);
        // 其它窗口跟着变大变小，被拖动的那个交给 mutter 自己处理
        this._applyLayout(layout, {skip: new Set([window])});

        // 注意：拖动期间**不**去写被拖动的那个窗口 —— 它的几何归合成器（交互式缩放）
        // 管，我们再写一次只会和它互相拉扯（表现为抽搐）。边界被钳制住时它可能临时
        // 越界，松手时这里已经套用好的布局会把它精确放到边界上。
    }

    /**
     * 把窗口的一条边推到 value；某一侧的分栏被压到最小尺寸之后，剩余位移继续交给
     * 「再外面」那条边界 —— 也就是「邻近窗口到最小后，邻近的邻近窗口接着调整」。
     *
     * 每一级都会核对：发生变化的窗口必须都在链上（当步的那两块 + 后续各级），
     * 否则整次级联回滚 —— 宁可这一帧不动，也不连累无关的窗口。
     *
     * @returns {boolean} 布局是否真的变了
     */
    _cascadeResize(layout, window, edge, value, {maxSteps = 16} = {}) {
        const area = this._areaFor(layout);
        if (!area)
            return false;
        const horizontal = edge === 'e' || edge === 'w';
        const edgeOf = cell => horizontal
            ? (edge === 'e' ? cell.x + cell.width : cell.x)
            : (edge === 's' ? cell.y + cell.height : cell.y);

        layout.tree.layout(area);
        const start = layout.tree.rectFor(window);
        if (!start)
            return false;
        let remaining = Math.round(value) - edgeOf(start);
        if (!remaining)
            return false;

        const ratios = layout.tree.snapshotRatios();
        const before = new Map(layout.tree.windows().map(w => [w, layout.tree.rectFor(w)]));
        const allowed = new Set();
        let current = window;
        let moved = false;

        for (let step = 0; step < maxSteps && remaining !== 0; step++) {
            layout.tree.layout(area);
            const cell = layout.tree.rectFor(current);
            if (!cell)
                break;
            const units = layout.tree.resizeUnits(current, edge);
            if (!units)
                break;
            for (const w of units.windows)
                allowed.add(w);
            const beforeEdge = edgeOf(cell);
            if (!layout.tree.setEdgeExact(current, edge, beforeEdge + remaining))
                break;
            // 只记「用户真正拖动的那条」：级联后面几级不算，客户端尺寸限制迁就时
            // 要优先动的是这条，而不是更外面的
            if (step === 0)
                layout.recentSplit = units.split;
            moved = true;
            layout.tree.layout(area);
            const afterCell = layout.tree.rectFor(current);
            remaining -= edgeOf(afterCell) - beforeEdge;
            if (!remaining)
                break;
            // 这一侧已经顶到最小尺寸：把剩余位移交给紧挨着的再外面那条边界
            const next = units.other.find(w => {
                const nextUnits = layout.tree.resizeUnits(w, edge);
                return nextUnits && nextUnits.split !== units.split;
            });
            if (!next)
                break;
            current = next;
        }

        if (!moved) {
            layout.tree.restoreRatios(ratios);
            layout.tree.layout(area);
            return false;
        }
        const intruders = layout.tree.windows().filter(w => !allowed.has(w) &&
            !this._sameRect(layout.tree.rectFor(w), before.get(w)));
        if (intruders.length) {
            layout.tree.restoreRatios(ratios);
            layout.tree.layout(area);
            this._log.log?.(`[codex-tiling] 级联缩放会连累 ${intruders.length} 个无关窗口，已回滚`);
            return false;
        }
        return true;
    }

    /* ---------------------------------------------------------------- 应用布局 */

    /** shell 自己正在做动效（概览等）时不要动窗口：那会和它的动画抢，看起来就是位置跳动。 */
    _shellBusy() {
        if (Main.overview?.visible) {
            return true;
        }
        return false;
    }

    /**
     * 概览 / 应用网格关掉之后：把显示期间攒下来的动作补上。
     *
     * 这些动作在概览打开时被_applyLayout / _dropMaximizeOnFocusChange 延后了：
     * 从概览里开新窗口、把窗口拖到别的桌面、在概览里切换窗口 —— 全都在「概览可见」
     * 的瞬间发生，直接丢掉就会出现「新窗口不参与平铺」「挪过来的窗口没加入布局」
     * 「切走焦点后原来那个最大化窗口还最大化着」。
     */
    _onShellIdle() {
        if (!this._enabled || this._shellBusy())
            return;
        const checkMaximize = this._pendingMaximizeCheck;
        const retile = this._pendingRetile;
        this._pendingMaximizeCheck = false;
        this._pendingRetile = false;
        if (checkMaximize)
            this._dropMaximizeOnFocusChange();
        if (retile)
            this.retileAll();
    }

    _applyLayout(layout, {skip = null} = {}) {
        if (!this._enabled || layout.paused || layout.tree.isEmpty)
            return;
        if (this._shellBusy()) {
            // 概览 / 应用网格正在显示：现在写几何会和它的动画抢，但要记下来等它关掉再补，
            // 不能丢掉 —— 从概览里开窗口、把窗口拖到别的桌面都发生在这个时候
            this._pendingRetile = true;
            return;
        }
        const area = this._areaFor(layout);
        if (!area)
            return;
        layout.tree.layout(area);
        for (const window of layout.tree.windows()) {
            if (skip?.has(window) || window.minimized)
                continue;
            const rect = layout.tree.rectFor(window);
            if (!rect)
                continue;
            // 已经在目标位置、而且没有多余状态（最大化 / 全屏）的窗口原样留着：
            // 少发一次几何请求，就少一次客户端与合成器的往返、也少一条复核链
            const target = this._rectOf(rect);
            if (this._sameRect(this._frameRect(window), target) &&
                (window.get_maximize_flags?.() ?? 0) === 0)
                continue;
            this._applyRect(window, target);
        }
    }

    /**
     * 把窗口摆进它的格子。摆放之后立即核对实际几何：客户端可能因为自己的尺寸
     * 限制（或只是慢半拍）没有照做，这时安排一次复核（见 _verifyLater）。
     */
    _applyRect(window, rect) {
        const target = this._rectOf(rect);
        if (!target)
            return;
        if (!this._writeRect(window, target))
            return;
        const after = this._frameRect(window);
        if (!this._sameRect(after, target))
            this._scheduleVerify(window, after);
    }

    /** 只把几何写进窗口，不安排复核（复核由调用方负责）。返回是否真的写了。 */
    _writeRect(window, target) {
        if (!window || window.minimized || (window.is_override_redirect?.() ?? false))
            return false;
        // 全屏窗口不归平铺管：动它的几何可能把全屏弄丢，等它退出全屏再说
        if (window.is_fullscreen?.() ?? false)
            return false;
        // 有对话框开着：父窗口此刻不重新平铺（动它会拽着对话框一起跳）
        if (this._hasOpenDialog(window))
            return false;

        this._rememberUserTime(window);
        this._guard++;
        try {
            // 需求 1 / 需求 6：平铺时窗口不能停留在最大化（或 mutter 的边缘平铺）状态
            if ((window.get_maximize_flags?.() ?? 0) !== 0) {
                this._internalMaximize.add(window);
                this._unmaximizeWindow(window);
            }
            const canResize = typeof window.allows_resize === 'function' ? window.allows_resize() : true;
            if (canResize)
                window.move_resize_frame(false, target.x, target.y, target.width, target.height);
            else
                window.move_frame(false, target.x, target.y);
        } finally {
            this._guard--;
        }
        return true;
    }

    _rectOf(rect) {
        if (!rect)
            return null;
        return {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.max(1, Math.round(rect.width)),
            height: Math.max(1, Math.round(rect.height)),
        };
    }

    /**
     * 写入的几何没生效（客户端不照做 / 慢半拍）时安排一次复核。
     *
     * 用户正在拖动 / 缩放窗口的这段时间里不安排：那期间几何归指针操作用，
     * 复核去写窗口只会和它抢（表现为抽搐、跳动）。松手之后 _applyLayout 会再写
     * 一次，那时重新安排就够了。
     */
    _scheduleVerify(window, observed) {
        if (!this._enabled || this._drag || this._resize || this._shellBusy())
            return;
        this._verifyLater(window, 0, observed ?? null, this._now());
    }

    _sameRect(a, b) {
        return !!a && !!b && a.x === b.x && a.y === b.y &&
            a.width === b.width && a.height === b.height;
    }

    /**
     * 摆放之后复核几何。
     *
     * 核对时以「布局此刻期望的矩形」为准，而不是当初写入的那个矩形：这期间布局
     * 可能已经变了（又插入了窗口、取消了最大化……），把旧矩形写回去会打乱新布局。
     *
     * 每次都按 VERIFY_DELAYS 的梯级看下去，只有当窗口**卡在同一个尺寸上持续**
     * 超过 ADOPT_SETTLE_MS 时，才认定那是客户端自己的尺寸限制，并让布局迁就它
     * （_adoptActualSize）。中途尺寸还在变的（例如 mutter 正在异步恢复旧几何）
     * 只会被重新摆一次，不会被误判。
     *
     * `observed` / `since` 是上一次观测到的实际几何与它首次出现的时间。
     */
    _verifyLater(window, step = 0, observed = null, since = 0) {
        if (step >= VERIFY_DELAYS.length)
            return;
        // 复核还在排队：这段时间里同一窗口的几何变化是「客户端不肯照做」或者
        // 「mutter 正在异步恢复旧几何」，不是窗口自主调整 —— 不要拿它去改布局
        if (step === 0)
            this._writeGuardUntil.set(window, this._now() + 2400);
        const delay = Math.max(16, VERIFY_DELAYS[step] - (VERIFY_DELAYS[step - 1] ?? 0));
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._timeoutSources.delete(id);
            this._safely(() => {
                if (!this._enabled || !this._managed.has(window) || window.minimized)
                    return;
                // 用户正在拖动 / 缩放：几何归指针操作用，任何复核都先让路
                // （松手之后 _applyLayout 会重新安排）
                if (this._drag || this._resize)
                    return;
                if ((window.get_maximize_flags?.() ?? 0) !== 0 || (window.is_fullscreen?.() ?? false))
                    return;
                if (this._shellBusy()) {
                    // 概览开着：过一会儿再看，别把这次核对丢掉
                    this._verifyLater(window, step, observed, since);
                    return;
                }
                const target = this._expectedRect(window);
                if (!target)
                    return; // 已经不在布局里了（被最小化、移走或布局换掉了）
                const current = this._frameRect(window);
                if (this._sameRect(current, target))
                    return; // 已经就位
                // 和上一次看到的一样 → 它卡住了；变了 → 重新开始计时
                const stable = !!observed && this._sameRect(current, observed);
                const stableSince = stable ? since : this._now();
                if (stable && this._now() - stableSince >= ADOPT_SETTLE_MS) {
                    this._adoptActualSize(window);
                    return;
                }
                this._writeRect(window, target);
                this._verifyLater(window, step + 1, current, stableSince);
            });
            return GLib.SOURCE_REMOVE;
        });
        this._timeoutSources.add(id);
    }

    /**
     * 某个窗口因为自身的尺寸限制没能填满格子（例如终端有最小尺寸、固定尺寸的窗口
     * 不肯放大）：改写布局里它那条分界线，让格子正好等于它的实际尺寸，
     * 让出来的空间由邻居吸收 —— 这样既不重叠也不留空位。
     */
    _adoptActualSize(window) {
        const layout = this._layoutFor(window);
        const area = this._areaFor(layout);
        const actual = this._frameRect(window);
        if (!layout || !area || !actual || layout.paused)
            return;
        // 用户正拿鼠标拖着：边界归指针，别在背后改写布局
        if (this._drag || this._resize)
            return;
        if (this._shellBusy())
            return;
        layout.tree.layout(area);
        const cell = layout.tree.rectFor(window);
        if (!cell)
            return;
        // 同一个「格子 → 实际尺寸」的僵局刚刚处理过就不再处理（防拉锯）；
        // 换了一种情况（布局变了、尺寸也变了）就正常迁就它
        const signature =
            `${cell.x},${cell.y} ${cell.width}x${cell.height}->${actual.width}x${actual.height}`;
        const last = this._adopted.get(window);
        if (last && last.signature === signature && this._now() - last.at < ADOPT_COOLDOWN_MS)
            return;

        // 以「它应该占的格子」为基准改写分界线。
        //
        // 两条边先试哪一条很关键：优先动**最近被拖动的那条**。典型场景是「左中右」
        // 三栏，把左边那栏拉大、中间那栏被压到客户端做不到的宽度 —— 这时多出来的
        // 空间应该由刚才被拉大的左边让回来（中间窗口的左边框），而不是去推右边那个
        // 用户根本没碰过、而且明明已经在自己格子里的窗口。另一条边动不了（贴着
        // 工作区边框）时再试另一侧。
        let changed = false;
        let usedEdge = null;
        if (actual.width !== cell.width) {
            const edge = this._adoptEdge(layout, window, 'h', cell, actual);
            if (edge) {
                changed = true;
                usedEdge = edge;
            }
        }
        if (actual.height !== cell.height) {
            const edge = this._adoptEdge(layout, window, 'v', cell, actual);
            if (edge) {
                changed = true;
                usedEdge = usedEdge ? `${usedEdge}${edge}` : edge;
            }
        }

        if (!changed || !this._enabled)
            return;
        this._adopted.set(window, {signature, at: this._now()});
        layout.tree.layout(area);
        this._log.log?.(`[codex-tiling] 迁就客户端的尺寸限制 ${window.get_wm_class?.() ?? '?'}：` +
            `格子 ${Math.round(cell.width)}x${Math.round(cell.height)} → 实际 ` +
            `${Math.round(actual.width)}x${Math.round(actual.height)}，改写的是 ${usedEdge} 边` +
            `（优先动最近拖过的那条）`);
        // 改写之后所有窗口（包括受限的这个）都按新格子摆一遍：
        // 受限的窗口挪到新位置后尺寸正好合适，邻居则让出了空间
        this._applyLayout(layout);
    }

    /**
     * 迁就客户端的尺寸限制：把窗口的格子改成它的实际尺寸。
     *
     * 先动**最近被拖动过的那条分界线**；这条边被「通用最小值」钳住时，放宽它再试
     * 一次，而不是转去推另一侧 —— 另一侧那个邻居用户根本没碰过，而且已经在自己
     * 的格子里。只有首选那条边根本不存在时，才退回到另一条边。
     *
     * @returns {string|null} 实际改写的那条边
     */
    _adoptEdge(layout, window, axis, cell, actual) {
        const leading = axis === 'h' ? 'e' : 's';
        const trailing = axis === 'h' ? 'w' : 'n';
        const {edges, preferred} = this._adoptEdgeOrder(layout, window, leading, trailing);
        const valueFor = edge => {
            if (axis === 'h')
                return edge === 'e' ? cell.x + actual.width : cell.x + cell.width - actual.width;
            return edge === 's' ? cell.y + actual.height : cell.y + cell.height - actual.height;
        };
        for (const [index, edge] of edges.entries()) {
            if (layout.tree.setEdgeExact(window, edge, valueFor(edge)))
                return edge;
            if (index === 0 && preferred &&
                layout.tree.setEdgeExact(window, edge, valueFor(edge), {minSize: 1}))
                return edge;
        }
        return null;
    }

    /**
     * 「迁就客户端尺寸」时两条边的尝试顺序：最近被拖动过的那条优先。
     * @returns {{edges: string[], preferred: boolean}}
     */
    _adoptEdgeOrder(layout, window, leading, trailing) {
        const recent = layout.recentSplit ?? null;
        if (recent) {
            const leadingSplit = layout.tree.resizeUnits(window, leading)?.split ?? null;
            const trailingSplit = layout.tree.resizeUnits(window, trailing)?.split ?? null;
            if (recent === trailingSplit && recent !== leadingSplit)
                return {edges: [trailing, leading], preferred: true};
            if (recent === leadingSplit && recent !== trailingSplit)
                return {edges: [leading, trailing], preferred: true};
        }
        return {edges: [leading, trailing], preferred: false};
    }

    /** 布局此刻期望窗口占据的矩形（窗口不在布局里时返回 null）。 */
    _expectedRect(window) {
        const layout = this._layoutFor(window);
        if (!layout || layout.paused || !layout.tree.findLeaf(window))
            return null;
        const rect = layout.tree.rectFor(window);
        if (!rect)
            return null;
        return {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.max(1, Math.round(rect.width)),
            height: Math.max(1, Math.round(rect.height)),
        };
    }

    /* -------------------------------------------------------------------- 工具 */

    _frameRect(window) {
        try {
            return window.get_frame_rect();
        } catch {
            return null;
        }
    }

    _areaFor(layout) {
        if (!layout)
            return null;
        const gap = this._settings.get_int('outer-gap');
        // 根节点不包含底部图标停靠区：占位的停靠区已经不在工作区里，
        // 不占位的（自动隐藏）再用 icon-area-inset 手动留出那一条。
        const inset = this._settings.get_int('icon-area-inset');
        let base = null;
        const workspace = layout.workspace;
        if (workspace)
            base = workspace.get_work_area_for_monitor(layout.monitorIndex);
        if (!base) {
            const monitor = Main.layoutManager.monitors?.[layout.monitorIndex];
            if (monitor)
                base = {x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height};
        }
        if (!base)
            return null;
        return {
            x: base.x + gap,
            y: base.y + gap,
            width: Math.max(1, base.width - 2 * gap),
            height: Math.max(1, base.height - 2 * gap - inset),
        };
    }

    /**
     * 窗口现在属于哪个工作区（对象本身，不用索引：动态增删桌面时索引会变）。
     */
    _refFor(window) {
        let workspace = null;
        try {
            workspace = window.get_workspace() ?? null;
        } catch {
            workspace = null;
        }
        if (!workspace)
            workspace = this._workspaceManager.get_active_workspace();
        return {workspace, monitorIndex: window.get_monitor()};
    }

    _layoutFor(window) {
        const ref = this._refs.get(window) ?? this._refFor(window);
        return this._store.get(ref.workspace, ref.monitorIndex, this._layoutDefaults());
    }

    _layoutDefaults() {
        return {
            gap: this._settings.get_int('gap'),
            minSize: this._settings.get_int('minimum-window-size'),
        };
    }

    _allTilableWindows() {
        const windows = this._display.list_all_windows().filter(isTilableWindow);
        try {
            return this._display.sort_windows_by_stacking(windows);
        } catch {
            return windows;
        }
    }

    /** 接管扩展启用前就已经存在的窗口（不改变它们的相对顺序）。 */
    _adoptExistingWindows() {
        for (const window of this._allTilableWindows()) {
            if (!this._managed.has(window))
                this._trackWindow(window);
            const layout = this._layoutFor(window);
            if (!layout)
                continue;

            if (window.minimized) {
                layout.minimized.add(window);
                continue;
            }
            if (layout.tree.findLeaf(window))
                continue;

            const area = this._areaFor(layout);
            if (!area)
                continue;
            layout.tree.layout(area);

            if (this._isActive(window)) {
                // 已经最大化的窗口：保持最大化，登记为这个桌面的最大化窗口
                // （它盖住整个工作区，不需要占格子；取消最大化时会自动插进布局）
                layout.maximized = window;
                layout.paused = true;
                continue;
            }

            this._splitBottomLeft(layout.tree, window);
        }

    }

    _trackWindow(window) {
        if (this._managed.has(window))
            return;
        this._managed.add(window);
        this._refs.set(window, this._refFor(window));

        const ids = [];
        const connect = (signal, callback) => {
            ids.push(window.connect(signal, () => this._safely(callback)));
        };
        connect('unmanaged', () => this._onUnmanaged(window));
        connect('workspace-changed', () => this._onRelocate(window));
        connect('notify::minimized', () => this._idle(() => this._onMinimizedChanged(window)));
        connect('notify::maximized-horizontally', () => this._idle(() => this._onMaximizeChanged(window)));
        connect('notify::maximized-vertically', () => this._idle(() => this._onMaximizeChanged(window)));
        connect('notify::fullscreen', () => this._idle(() => this._onMaximizeChanged(window)));
        connect('size-changed', () => this._onSizeChanged(window));
        connect('position-changed', () => this._onPositionChanged(window));
        // 变成对话框 / 浮动窗口的迹象（文件选择器之类）一出现就复核
        connect('notify::window-type', () => this._idle(() => this._reevaluateWindow(window)));
        connect('notify::skip-taskbar', () => this._idle(() => this._reevaluateWindow(window)));
        this._windowSignalIds.set(window, ids);
    }

    _untrackWindow(window) {
        const ids = this._windowSignalIds.get(window);
        if (ids) {
            for (const id of ids) {
                try {
                    window.disconnect(id);
                } catch {
                    // 忽略已经失效的处理器
                }
            }
            this._windowSignalIds.delete(window);
        }
        this._managed.delete(window);
        this._refs.delete(window);
        this._recency = this._recency.filter(w => w !== window);
    }

    _connect(object, signal, callback) {
        const id = object.connect(signal, (...args) => this._safely(() => callback(...args)));
        this._signalIds.push([object, id]);
        return id;
    }

    _idle(callback) {
        // 用 HIGH_IDLE：新窗口尽量在当前这一轮就位，减少可见的二次调整
        const id = GLib.idle_add(GLib.PRIORITY_HIGH_IDLE, () => {
            this._timeoutSources.delete(id);
            this._safely(callback);
            return GLib.SOURCE_REMOVE;
        });
        this._timeoutSources.add(id);
        return id;
    }

    _safely(callback) {
        try {
            return callback();
        } catch (error) {
            this._log.error(`[codex-tiling] 内部错误: ${error}\n${error?.stack ?? ''}`);
            return undefined;
        }
    }

    /**
     * `Meta.Window.maximize` / `unmaximize` 的参数在不同 mutter 版本里不一样：
     * 45–50 需要 `Meta.MaximizeFlags.BOTH`，51 变成 0 个参数（多传会打
     * 「Too many arguments to method Meta.Window.unmaximize」的 JS WARNING）。
     *
     * 先按 0 参数调用；老版本缺参数会抛错，或者调用后状态没变，再带上 flags 重试。
     */
    _maximizeWindow(window) {
        if ((window.get_maximize_flags?.() ?? 0) === Meta.MaximizeFlags.BOTH)
            return;
        try {
            window.maximize();
        } catch {
            window.maximize(Meta.MaximizeFlags.BOTH);
            return;
        }
        if ((window.get_maximize_flags?.() ?? 0) === 0) {
            try {
                window.maximize(Meta.MaximizeFlags.BOTH);
            } catch {
                // 老版本已经成功、新版本不接受参数时都会走到这里，忽略即可
            }
        }
    }

    _unmaximizeWindow(window) {
        if ((window.get_maximize_flags?.() ?? 0) === 0)
            return;
        try {
            window.unmaximize();
        } catch {
            window.unmaximize(Meta.MaximizeFlags.BOTH);
            return;
        }
        if ((window.get_maximize_flags?.() ?? 0) !== 0) {
            try {
                window.unmaximize(Meta.MaximizeFlags.BOTH);
            } catch {
                // 同上
            }
        }
    }

    _minimizeInternal(window) {
        this._internalMinimize.add(window);
        if (!window.minimized)
            window.minimize();
    }

    _maximizeInternal(window) {
        this._internalMaximize.add(window);
        // 全屏窗口本来就占满整个工作区，不用（也不该）再给它加最大化状态
        if (window.is_fullscreen?.() ?? false)
            return;
        if ((window.get_maximize_flags?.() ?? 0) !== Meta.MaximizeFlags.BOTH)
            this._maximizeWindow(window);
    }

    /** 需求 6：让 window 接着占据这个桌面的「最大化位置」。 */
    _takeOverMaximizedSlot(layout, window) {
        layout.maximized = window;
        layout.paused = true;
        this._maximizeInternal(window);
    }

    _unminimizeInternal(window) {
        this._internalUnminimize.add(window);
        if (window.minimized)
            window.unminimize();
    }

    _unmaximizeInternal(window) {
        this._internalMaximize.add(window);
        this._unmaximizeWindow(window);
    }

    /** 单调时钟（毫秒），只用来判断窗口是不是刚出现。 */
    _now() {
        return GLib.get_monotonic_time() / 1000;
    }

    _rememberUserTime(window) {
        try {
            this._userTimeSeen.set(window, window.get_user_time?.() ?? 0);
        } catch {
            this._userTimeSeen.set(window, 0);
        }
    }

    /**
     * 这个最大化是不是「窗口自己带出来的」（应用启动时主动最大化、mutter 的摆放），
     * 而不是用户按下的？
     *
     * 判据一：它出现在窗口刚创建之后不久；
     * 判据二：窗口的用户操作时间自我们上次摆放它以来没有前进 —— 用户如果点了标题栏
     *        上的最大化按钮、双击标题栏，mutter 会把窗口的用户操作时间刷新掉。
     * 两者同时成立才认为是「自带的」，避免把用户的最大化也吃掉。
     */
    _isSelfMaximize(window) {
        const created = this._createdAt.get(window);
        if (created === undefined || this._now() - created >= NEW_WINDOW_GRACE_MS)
            return false;
        let userTime = 0;
        try {
            userTime = window.get_user_time?.() ?? 0;
        } catch {
            userTime = 0;
        }
        return userTime <= (this._userTimeSeen.get(window) ?? 0);
    }

    _isActive(window) {
        return (window.get_maximize_flags?.() ?? 0) !== 0 || (window.is_fullscreen?.() ?? false);
    }

    _cancelInteraction() {
        this._drag = null;
        this._resize = null;
        this._stopResizePoll();
        this._preview?.hide();
    }

    _applySettingsToLayouts() {
        const gap = this._settings.get_int('gap');
        const minSize = this._settings.get_int('minimum-window-size');
        for (const layout of this._store.entries()) {
            layout.tree.gap = gap;
            layout.tree.minSize = minSize;
        }
    }

    _onToggled() {
        if (this._settings.get_boolean('enabled'))
            this._resume(true);
        else
            this._suspend();
    }

    /**
     * 用户把平铺开关打开：接管 mutter 的贴边吸附，把桌面上的窗口收进布局。
     *
     * @param {boolean} rearrange 是否马上重新排列已有窗口（设置项里那条开关的语义）
     */
    _resume(rearrange = true) {
        this._applyEdgeTilingSetting();
        this._applySettingsToLayouts();
        // 已经开着的对话框也登记一下（扩展启用之前就弹出来的那些）
        for (const window of this._display.list_all_windows())
            this._watchDialog(window);
        if (rearrange) {
            this._adoptExistingWindows();
            this.retileAll();
        } else {
            for (const window of this._allTilableWindows())
                this._trackWindow(window);
        }
    }

    /**
     * 用户把平铺开关关掉（系统菜单里的那个开关，或者「扩展」应用里的开关）。
     *
     * 关掉之后**彻底放手**：窗口不再受管，布局与状态清空（再次打开时重新接管），
     * mutter 的贴边吸附还回去。之前这里只取消了一次拖放、没有解除接管，于是关掉
     * 平铺之后窗口仍在被扩展摆布 —— 用户把窗口拖到屏幕边缘做贴边吸附时，
     * 扩展又会把这次最大化当成「平铺里的最大化」处理，看起来就是自带的吸附坏了。
     */
    _suspend() {
        this._cancelInteraction();
        this._restoreEdgeTiling();
        this._pendingRetile = false;
        this._pendingMaximizeCheck = false;
        this._evicted.clear();
        this._forgetDialogs();
        for (const window of [...this._managed])
            this._untrackWindow(window);
        this._managed.clear();
        this._refs.clear();
        this._recency = [];
        this._internalMinimize.clear();
        this._internalUnminimize.clear();
        this._internalMaximize.clear();
        this._store.clear();
    }

    /* ------------------------------------------- 与 mutter 自带边缘平铺的关系 */

    /**
     * mutter 自己也会在拖到边缘时平铺/最大化窗口（贴边吸附），这会和需求 4 冲突，
     * 所以**平铺生效期间**把 org.gnome.mutter 的 edge-tiling 设为 false，
     * 平铺一关就把它写回接管之前的值（见 _restoreEdgeTiling）。
     *
     * 注意这里只在「平铺生效」时调用：用户在设置里把平铺关掉之后，扩展加载时
     * 也不能去动 mutter 的设置，否则关着平铺的时候贴边吸附会一直是坏的。
     */
    _applyEdgeTilingSetting() {
        try {
            const source = Gio.SettingsSchemaSource.get_default();
            if (!source?.lookup('org.gnome.mutter', true))
                return;
            if (!this._mutterSettings)
                this._mutterSettings = new Gio.Settings({schema_id: 'org.gnome.mutter'});
            // 只在还没记过的时候记一次。存在扩展自己的设置里，所以上一次 Shell 没有
            // 干净退出（没跑到恢复）也认得出来，不会把当时写下的 false 当成用户的选择
            if (this._settings.get_string('mutter-edge-tiling-backup') === '')
                this._settings.set_string('mutter-edge-tiling-backup',
                    this._mutterSettings.get_boolean('edge-tiling') ? 'true' : 'false');
            if (this._mutterSettings.get_boolean('edge-tiling'))
                this._mutterSettings.set_boolean('edge-tiling', false);
        } catch (error) {
            this._log.warn(`[codex-tiling] 无法调整 mutter 的 edge-tiling：${error}`);
        }
    }

    /** 退出接管：把 mutter 的贴边吸附还给用户。 */
    _restoreEdgeTiling() {
        try {
            const stored = this._settings.get_string('mutter-edge-tiling-backup');
            if (!this._mutterSettings || stored === '')
                return;
            // 只在「我们写下的 false 还在」时改回去：用户在这期间自己动过这个开关，
            // 就尊重用户的值，不去覆盖
            if (!this._mutterSettings.get_boolean('edge-tiling'))
                this._mutterSettings.set_boolean('edge-tiling', stored === 'true');
            this._settings.set_string('mutter-edge-tiling-backup', '');
        } catch (error) {
            this._log.warn(`[codex-tiling] 恢复 mutter edge-tiling 失败：${error}`);
        }
    }

    /**
     * 可选：当前桌面上没有任何非最小化窗口时自动进入概览，方便直接挑窗口 / 开新应用。
     * 默认关闭（settings: show-overview-when-empty）。
     */
    _maybeShowOverview() {
        if (!this._enabled || !this._settings.get_boolean('enabled') ||
            !this._settings.get_boolean('show-overview-when-empty'))
            return;
        this._idle(() => {
            if (!this._enabled || !this._settings.get_boolean('enabled') || Main.overview?.visible)
                return;
            if (!this._settings.get_boolean('show-overview-when-empty'))
                return;
            const workspace = this._workspaceManager.get_active_workspace();
            if (!workspace)
                return;
            if (workspace.list_windows().some(window => !window.minimized))
                return;
            Main.overview.show();
        });
    }

}
