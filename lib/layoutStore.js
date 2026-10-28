// SPDX-License-Identifier: MIT
/*
 * layoutStore.js —— 每个「工作区 × 显示器」一份布局状态。
 *
 * 键用的是**工作区对象本身**，不是它的索引：GNOME 的动态工作区在增删之后，
 * 后面所有桌面的索引会整体前移，用索引当键会让布局串到别的桌面上
 * （表现就是「系统自动增删桌面之后，平铺变得很奇怪」）。
 *
 * 之所以按显示器再分一层，是因为每块屏幕有自己的工作区和一套平铺格子；
 * 窗口在显示器之间移动与在工作区之间移动遵循同一套规则（README 需求 7）。
 */

import {LayoutTree} from './layoutTree.js';

export class MonitorLayout {
    constructor({workspace, monitorIndex, gap = 0, minSize = 120}) {
        this.workspace = workspace;
        this.monitorIndex = monitorIndex;
        this.tree = new LayoutTree({gap, minSize});
        /** 被最小化的窗口（包括需求 2 顶替时被隐藏的窗口）：不参与平铺。 */
        this.minimized = new Set();
        /**
         * 被最小化的窗口 → 它最小化之前的位置（兄弟节点 + 分割方向与比例）。
         * 用户自己最小化之后又还原时，按这个记忆精确放回原处；记不起来的
         * （被新窗口顶替、跨桌面移动）就退回「与最左下窗口上下平铺」。
         */
        this.preMinimize = new Map();
        /** 当前最大化的窗口（每个桌面 × 显示器最多一个，需求 6）。 */
        this.maximized = null;
        /** 最大化期间冻结布局，取消最大化后再一次性恢复。 */
        this.paused = false;
    }

    /** 当前的工作区索引（动态增删桌面后会变，所以每次现取）。 */
    get workspaceIndex() {
        return this.workspace?.index?.() ?? 0;
    }
}

export class LayoutStore {
    constructor(workspaceManager = null) {
        this._workspaceManager = workspaceManager;
        /** Meta.Workspace -> Map<monitorIndex, MonitorLayout> */
        this._layouts = new Map();
    }

    /** 允许传工作区对象，也允许传索引（测试与调试时方便）。 */
    _resolveWorkspace(workspace) {
        if (workspace && typeof workspace.index === 'function')
            return workspace;
        if (typeof workspace === 'number')
            return this._workspaceManager?.get_workspace_by_index(workspace) ?? null;
        return null;
    }

    get(workspace, monitorIndex, defaults = {}) {
        const resolved = this._resolveWorkspace(workspace);
        if (!resolved)
            return null;

        let perMonitor = this._layouts.get(resolved);
        if (!perMonitor) {
            perMonitor = new Map();
            this._layouts.set(resolved, perMonitor);
        }

        let layout = perMonitor.get(monitorIndex);
        if (!layout) {
            layout = new MonitorLayout({workspace: resolved, monitorIndex, ...defaults});
            perMonitor.set(monitorIndex, layout);
        }
        return layout;
    }

    entries() {
        const out = [];
        for (const perMonitor of this._layouts.values())
            out.push(...perMonitor.values());
        return out;
    }

    clear() {
        this._layouts.clear();
    }

    /**
     * 回收状态：工作区已经被系统删掉、或者布局里已经没有任何窗口信息，
     * 就把这一份丢掉（动态工作区增删时尤其重要）。
     */
    prune() {
        for (const [workspace, perMonitor] of [...this._layouts]) {
            if (!this._isAlive(workspace)) {
                this._layouts.delete(workspace);
                continue;
            }
            for (const [monitorIndex, layout] of [...perMonitor]) {
                if (layout.tree.isEmpty && layout.minimized.size === 0 &&
                    layout.preMinimize.size === 0 && !layout.maximized)
                    perMonitor.delete(monitorIndex);
            }
            if (perMonitor.size === 0)
                this._layouts.delete(workspace);
        }
    }

    /** 工作区是否还在（被系统删掉的桌面，它上面已经没有窗口了）。 */
    _isAlive(workspace) {
        const manager = this._workspaceManager;
        if (!manager || typeof manager.get_n_workspaces !== 'function')
            return true;
        for (let i = 0; i < manager.get_n_workspaces(); i++) {
            if (manager.get_workspace_by_index(i) === workspace)
                return true;
        }
        return false;
    }
}
