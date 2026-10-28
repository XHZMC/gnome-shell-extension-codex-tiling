// SPDX-License-Identifier: MIT
/*
 * harness.js —— 在真实的 GNOME Shell 进程里跑一遍需求 1~7 的端到端测试。
 *
 * 它本身是第二个（临时的）扩展：由 tests/live/run.sh 复制到一个隔离的
 * XDG_DATA_HOME 里，并和被测扩展一起启用。它通过 Extension.lookupByUUID()
 * 拿到被测扩展实例，调用它的自动化钩子，然后读取真实 Meta.Window 的几何与
 * 最大化/最小化状态来断言，最后把结果写进 JSON 报告文件。
 */

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const TARGET_UUID = 'codex-tiling@codex.local';
const CLIENT = GLib.getenv('CT_CLIENT') ?? 'client.py';
const REPORT = GLib.getenv('CT_REPORT') ?? '/tmp/codex-tiling-report.json';
const SCREENSHOT = GLib.getenv('CT_SCREENSHOT') ?? '';

const sleep = ms => new Promise(resolve => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    });
});

const rect = window => {
    const r = window.get_frame_rect();
    return {x: r.x, y: r.y, width: r.width, height: r.height};
};
const sameRect = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y &&
    a.width === b.width && a.height === b.height;
const overlap = (a, b) =>
    Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 0 &&
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 0;
const pairInside = (rects, area) => rects.every(r => inside(r, area));
const inside = (r, area) => r.x >= area.x - 1 && r.y >= area.y - 1 &&
    r.x + r.width <= area.x + area.width + 1 &&
    r.y + r.height <= area.y + area.height + 1;
const fmt = r => r ? `(${r.x},${r.y} ${r.width}x${r.height})` : 'null';

class Report {
    constructor() {
        this.cases = [];
        this.notes = [];
    }

    check(name, pass, detail = '') {
        this.cases.push({name, pass: !!pass, detail: String(detail)});
    }

    note(text) {
        this.notes.push(String(text));
    }

    write() {
        const failed = this.cases.filter(c => !c.pass).length;
        GLib.file_set_contents(REPORT, JSON.stringify({
            total: this.cases.length,
            failed,
            cases: this.cases,
            notes: this.notes,
        }, null, 2));
    }
}

export default class HarnessExtension extends Extension {
    enable() {
        this._report = new Report();
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
            this._suite().catch(error => {
                this._report.check(`测试脚本异常: ${error}`, false, error?.stack ?? '');
                this._report.write();
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    disable() {
    }

    /* ------------------------------------------------------------------ 工具 */

    _title(window) {
        try {
            return window.get_title();
        } catch {
            return '?';
        }
    }

    _workArea() {
        const workspace = global.workspace_manager.get_active_workspace();
        const area = workspace.get_work_area_for_monitor(0);
        return {x: area.x, y: area.y, width: area.width, height: area.height};
    }

    _spawnClient(title, width = 700, height = 500, flags = []) {
        try {
            GLib.spawn_async(null,
                ['python3', CLIENT, title, String(width), String(height), ...flags],
                null, GLib.SpawnFlags.SEARCH_PATH, null);
        } catch (error) {
            this._report.note(`启动客户端失败: ${error}`);
        }
        return this._waitForWindow(title);
    }

    async _waitForWindow(title, timeoutMs = 20000) {
        const deadline = GLib.get_monotonic_time() + timeoutMs * 1000;
        while (GLib.get_monotonic_time() < deadline) {
            const found = global.display.list_all_windows()
                .find(w => this._title(w) === title);
            if (found)
                return found;
            await sleep(150);
        }
        return null;
    }

    _layoutOf(manager, window) {
        return manager.store.get(window.get_workspace().index(), window.get_monitor());
    }

    /* ------------------------------------------------------------------ 场景 */

    async _suite() {
        const report = this._report;
        const extension = Extension.lookupByUUID(TARGET_UUID);
        report.check('被测扩展已加载', !!extension, TARGET_UUID);
        if (!extension) {
            report.write();
            return;
        }

        const manager = extension.tiling;
        report.check('扩展对外暴露平铺管理器', !!manager, typeof manager);
        if (!manager) {
            report.write();
            return;
        }

        // 「空桌面自动进概览」默认开启：测试流程中途桌面会变空，概览会把窗口卷进
        // 工作区缩略图、影响后面的几何断言，所以先关掉，最后再单独验证它。
        extension.getSettings().set_boolean('show-overview-when-empty', false);

        const area = this._workArea();
        report.note(`工作区: ${fmt(area)} 显示器数: ${global.display.get_n_monitors()}`);

        /* ---------------- 需求 1 ---------------- */
        const w1 = await this._spawnClient('W1');
        report.check('测试客户端 W1 打开成功', !!w1);
        if (!w1) {
            report.write();
            return;
        }
        await sleep(1500);
        report.check('需求1 · 第一个窗口铺满整个工作区', sameRect(rect(w1), area),
            `${fmt(rect(w1))} 期望 ${fmt(area)}`);
        report.check('需求1 · 该窗口没有进入最大化状态',
            w1.get_maximize_flags() === 0 && !w1.is_fullscreen(),
            `maximize-flags=${w1.get_maximize_flags()} fullscreen=${w1.is_fullscreen()}`);
        let layout = this._layoutOf(manager, w1);
        report.check('需求1 · 布局中只有这一个窗口', layout?.tree.windows().length === 1,
            `windows=${layout?.tree.windows().length}`);

        /* ---------------- 需求 2 ---------------- */
        const w2 = await this._spawnClient('W2');
        report.check('测试客户端 W2 打开成功', !!w2);
        await sleep(1500);
        if (w2) {
            layout = this._layoutOf(manager, w2);
            layout.tree.layout(area);
            report.check('需求2 · 新窗口按通常方式平铺（不顶替、不最小化任何窗口）',
                !w1.minimized && !w2.minimized && layout.tree.windows().length === 2,
                `w1.minimized=${w1.minimized} w2.minimized=${w2.minimized} ` +
                `windows=${layout.tree.windows().length}`);
            report.check('需求2 · 两个窗口上下平铺、互不重叠',
                !overlap(rect(w1), rect(w2)) &&
                pairInside([rect(w1), rect(w2)], area),
                `${fmt(rect(w1))} / ${fmt(rect(w2))}`);
        }

        /* ---------------- 需求 3：最小化再还原 → 从左下开始平铺 ---------------- */
        if (w2) {
            layout = this._layoutOf(manager, w2);
            layout.tree.layout(area);
            w2.minimize();
            await sleep(1500);
            w2.unminimize();
            await sleep(1800);
            layout.tree.layout(area);
            const w2Cell = layout.tree.rectFor(w2);
            report.check('需求3 · 最小化后还原 → 从左下开始平铺（和左下角窗口上下均分）',
                !w2.minimized && sameRect(rect(w2), w2Cell) &&
                w2Cell.y + w2Cell.height === area.y + area.height,
                `${fmt(rect(w2))} 布局 ${fmt(w2Cell)}`);
        }

        /* ---------------- 需求 4a / 4b：拖到另一个窗口的边上 ----------------
         * 此时桌面上只有 w1 / w2：被拖动的窗口腾出的空间会被另一个窗口吸收，
         * 所以「与那个窗口平分它的格子」正好就是「占满半屏」。
         */
        const halfLeft = {
            x: area.x, y: area.y,
            width: Math.round(area.width / 2), height: area.height,
        };
        // 指针落在另一个窗口的格子里、贴着它的左边缘
        manager.dropAt(w1, area.x + 4, area.y + 40);
        await sleep(1200);
        report.check('需求4a · 拖到另一个窗口的左侧边缘 → 与它平分该格子（左半边）',
            sameRect(rect(w1), halfLeft),
            `${fmt(rect(w1))} 期望 ${fmt(halfLeft)}`);

        const halfTop = {
            x: area.x, y: area.y,
            width: area.width, height: Math.round(area.height / 2),
        };
        // 指针落在另一个窗口的格子里、贴着它的上边缘
        manager.dropAt(w1, area.x + Math.round(area.width * 0.75), area.y + 4);
        await sleep(1200);
        report.check('需求4b · 拖到另一个窗口的上边缘 → 与它上下平分该格子（上半屏）',
            sameRect(rect(w1), halfTop),
            `${fmt(rect(w1))} 期望 ${fmt(halfTop)}`);

        /* ---------------- 准备三个可见窗口 ---------------- */
        const w3 = await this._spawnClient('W3');
        await sleep(1500);
        for (const window of [w1, w2].filter(w => w && w.minimized))
            window.unminimize();
        await sleep(1500);
        const all = [w1, w2, w3].filter(Boolean);
        layout = this._layoutOf(manager, w3 ?? w1);
        report.check('准备 · 三个窗口同时可见',
            all.length === 3 && all.every(w => !w.minimized) && layout?.tree.windows().length === 3,
            all.map(w => `${this._title(w)}:${w.minimized ? 'min' : 'ok'}`).join(' '));

        /* ---------------- 需求 4c：拖到两个窗口中间 ---------------- */
        layout.tree.layout(area);
        const dragged = w1;
        const boundaries = layout.tree.boundaries();
        const boundary = boundaries.find(b =>
            b.before.window !== dragged && b.after.window !== dragged) ?? boundaries[0];
        if (boundary) {
            let along = boundary.from + Math.round((boundary.to - boundary.from) / 2);
            // 一条分界线可能横贯整个工作区：把指针挪到「两侧都不是被拖动窗口」的高度上
            for (let k = 1; k <= 5; k++) {
                const at = boundary.from + Math.round((boundary.to - boundary.from) * k / 6);
                const adjacent = layout.tree.leavesAtBoundary(boundary, at);
                if (adjacent.before.window !== dragged && adjacent.after.window !== dragged) {
                    along = at;
                    break;
                }
            }
            const pointer = boundary.orientation === 'h'
                ? [boundary.position, along]
                : [along, boundary.position];
            const adjacent = layout.tree.leavesAtBoundary(boundary, along);
            const neighbours = [adjacent.before.window, adjacent.after.window];
            manager.dropAt(dragged, pointer[0], pointer[1]);
            await sleep(1200);
            const order = layout.tree.windows();
            const index = order.indexOf(dragged);
            const between = index > 0 && index < order.length - 1 &&
                neighbours.includes(order[index - 1]) && neighbours.includes(order[index + 1]);
            report.check('需求4c · 拖到两个窗口中间 → 插到它们之间', between,
                `顺序 ${order.map(w => this._title(w)).join(' | ')}`);
        } else {
            report.check('需求4c · 拖到两个窗口中间', false, '没有可用的相邻分界线');
        }

        /* ---------------- 需求 4d：拖到另一个窗口上 → 交换 ---------------- */
        layout.tree.layout(area);
        // 只有「格子中心离边缘足够远」的窗口才会被判定成交换，而不是吸附到边上
        const threshold = extension.getSettings().get_int('edge-threshold');
        const targetLeaf = layout.tree.leaves().find(leaf => {
            if (leaf.window === dragged)
                return false;
            const rect = layout.tree.rectFor(leaf.window);
            return rect && Math.min(rect.width, rect.height) > 3 * threshold;
        }) ?? null;
        if (targetLeaf) {
            const dragBefore = rect(dragged);
            const targetBefore = rect(targetLeaf.window);
            const targetRect = layout.tree.nodeRect(targetLeaf);
            manager.dropAt(dragged,
                targetRect.x + Math.round(targetRect.width / 2),
                targetRect.y + Math.round(targetRect.height / 2));
            await sleep(1200);
            report.check('需求4d · 拖到另一个窗口上 → 两个窗口交换位置',
                sameRect(rect(dragged), targetBefore) && sameRect(rect(targetLeaf.window), dragBefore),
                `被拖动 ${fmt(dragBefore)}→${fmt(rect(dragged))}；目标 ${fmt(targetBefore)}→${fmt(rect(targetLeaf.window))}`);
        } else {
            report.check('需求4d · 拖到另一个窗口上 → 交换位置', false, '没有可交换的窗口');
        }

        /* ---------------- 需求 5：拖动边缘联动 ---------------- */
        for (const window of [w1, w2, w3].filter(Boolean)) {
            if (window !== dragged && !window.minimized && this._title(window) === 'W3')
                window.minimize();
        }
        await sleep(1200);
        // 此时桌面上只剩 dragged 与伙伴两个平铺窗口，把 dragged 放到伙伴的左边缘：
        // 伙伴吸收它腾出的空间后占满工作区，于是两者各得左右半边
        layout.tree.layout(area);
        const partnerLeaf = layout.tree.leaves().find(leaf => leaf.window !== dragged) ?? null;
        if (partnerLeaf) {
            const partnerRect = layout.tree.rectFor(partnerLeaf.window);
            manager.dropAt(dragged, partnerRect.x + 4, partnerRect.y + Math.round(partnerRect.height / 2));
            await sleep(1200);
        }
        const partner = [w1, w2, w3].filter(Boolean)
            .find(w => w !== dragged && !w.minimized);
        const halfRight = {
            x: area.x + Math.round(area.width / 2), y: area.y,
            width: area.width - Math.round(area.width / 2), height: area.height,
        };
        report.check('需求5 · 准备：被拖动窗口在左半、伙伴窗口在右半',
            sameRect(rect(dragged), halfLeft) && !!partner && sameRect(rect(partner), halfRight),
            `${fmt(rect(dragged))} / ${partner ? fmt(rect(partner)) : 'null'}`);

        if (partner) {
            const targetWidth = 400;
            dragged.move_resize_frame(true, area.x, area.y, targetWidth, area.height);
            await sleep(700);
            manager.commitResize(dragged, ['e']);
            await sleep(1200);
            const expectedPartner = {
                x: area.x + targetWidth, y: area.y,
                width: area.width - targetWidth, height: area.height,
            };
            report.check('需求5 · 拖动窗口边缘后其余窗口联动调整大小',
                sameRect(rect(dragged), {x: area.x, y: area.y, width: targetWidth, height: area.height}) &&
                sameRect(rect(partner), expectedPartner),
                `${fmt(rect(dragged))} / 伙伴 ${fmt(rect(partner))} 期望 ${fmt(expectedPartner)}`);
        }

        /* ---------------- 需求 3：最小化后还原 → 从左下开始平铺 ---------------- */
        dragged.minimize();
        await sleep(1500);
        dragged.unminimize();
        await sleep(1800);
        layout.tree.layout(area);
        report.check('需求3 · 最小化后还原 → 从左下开始平铺',
            sameRect(rect(dragged), layout.tree.rectFor(dragged)) &&
            rect(dragged).y + rect(dragged).height === area.y + area.height,
            `${fmt(rect(dragged))} 布局 ${fmt(layout.tree.rectFor(dragged))}`);

        /* ---------------- 需求 6：最大化 ---------------- */
        for (const window of [w1, w2, w3].filter(Boolean)) {
            if (window.minimized)
                window.unminimize();
        }
        await sleep(1500);
        const visible = [w1, w2, w3].filter(w => w && !w.minimized);
        const snapshot = visible.map(window => ({window, rect: rect(window)}));
        report.check('需求6 · 准备：至少两个可见窗口', visible.length >= 2, `可见 ${visible.length}`);

        if (visible.length >= 2) {
            const [first, second] = visible;
            first.maximize(Meta.MaximizeFlags.BOTH);
            await sleep(1500);
            report.check('需求6 · 最大化行为正常生效',
                first.get_maximize_flags() === Meta.MaximizeFlags.BOTH,
                `flags=${first.get_maximize_flags()}`);
            report.check('需求6 · 最大化不影响其它窗口（它们留在原格子里，被最大化窗口盖住）',
                snapshot.slice(1).every(s => !s.window.minimized && sameRect(rect(s.window), s.rect)),
                snapshot.slice(1)
                    .map(s => `${this._title(s.window)}:${fmt(rect(s.window))} vs ${fmt(s.rect)}`)
                    .join('; '));

            first.unmaximize(Meta.MaximizeFlags.BOTH);
            await sleep(1800);
            report.check('需求6 · 取消最大化后恢复最大化之前的布局',
                snapshot.every(s => !s.window.minimized && sameRect(rect(s.window), s.rect)),
                snapshot.map(s => `${this._title(s.window)}:${fmt(rect(s.window))} vs ${fmt(s.rect)}`)
                    .join('; '));

            second.maximize(Meta.MaximizeFlags.BOTH);
            await sleep(1500);
            report.check('需求6 · 每个桌面最多一个可见的最大化窗口（前一个被取消最大化）',
                second.get_maximize_flags() === Meta.MaximizeFlags.BOTH &&
                !second.minimized &&
                first.get_maximize_flags() === 0,
                `第一个 flags=${first.get_maximize_flags()} minimized=${first.minimized}，` +
                `第二个 flags=${second.get_maximize_flags()} minimized=${second.minimized}`);

            // 从最大化的窗口切到另一个窗口：只取消原来那个窗口的最大化
            const secondCell = snapshot.find(s => s.window === second)?.rect ?? rect(second);
            first.activate(global.get_current_time());
            await sleep(2000);
            report.check('需求6 · 切走焦点只取消原来的最大化（新焦点保持普通平铺）',
                second.get_maximize_flags() === 0 && first.get_maximize_flags() === 0 &&
                !first.minimized,
                `第一个 flags=${first.get_maximize_flags()}，第二个 flags=${second.get_maximize_flags()}`);
            report.check('需求6 · 原来的窗口回到它的格子',
                sameRect(rect(second), secondCell),
                `${fmt(rect(second))} 期望 ${fmt(secondCell)}`);

            for (const window of [first, second].filter(w => w.get_maximize_flags() !== 0)) {
                window.touchedByUser?.();
                window.unmaximize(Meta.MaximizeFlags.BOTH);
            }
            await sleep(1800);
            report.check('需求6 · 再次取消最大化后布局与窗口都回到最大化之前',
                snapshot.every(s => !s.window.minimized && sameRect(rect(s.window), s.rect)),
                snapshot.map(s => `${this._title(s.window)}:${fmt(rect(s.window))} vs ${fmt(s.rect)}`)
                    .join('; '));

            // 回归：最大化窗口被关掉之后，焦点窗口并不是最大化窗口，
            // 此后新开的窗口必须是平铺的（不能把「最大化」当成会一直留着的历史状态）
            first.maximize(Meta.MaximizeFlags.BOTH);
            await sleep(1200);
            first.delete(global.get_current_time());
            await sleep(1800);
            const late = await this._spawnClient('W6');
            await sleep(1800);
            report.check('需求6 · 关掉最大化窗口之后新开的窗口是平铺的',
                !!late && late.get_maximize_flags() === 0 && !late.minimized,
                late ? `flags=${late.get_maximize_flags()} minimized=${late.minimized}`
                    : '新窗口没有打开成功');
        }

        /* ---------------- 需求 6 补充 + 对话框不参与平铺 ---------------- */
        const selfMaximized = await this._spawnClient('W7', 700, 500, ['--maximize']);
        await sleep(2500);
        if (selfMaximized) {
            const layout7 = this._layoutOf(manager, selfMaximized);
            layout7.tree.layout(this._workArea());
            report.check('需求6 · 应用启动时自己最大化的窗口会被取消并平铺',
                selfMaximized.get_maximize_flags() === 0 && !selfMaximized.minimized &&
                sameRect(rect(selfMaximized), layout7.tree.rectFor(selfMaximized)),
                `flags=${selfMaximized.get_maximize_flags()} ${fmt(rect(selfMaximized))} ` +
                `期望 ${fmt(layout7.tree.rectFor(selfMaximized))}`);

            // 回归：取消最大化后必须铺满自己的格子 ——
            // mutter 恢复「最大化前的几何」是异步的，可能落在扩展摆好布局之后
            selfMaximized.touchedByUser?.();
            selfMaximized.maximize(Meta.MaximizeFlags.BOTH);
            await sleep(1500);
            selfMaximized.unmaximize(Meta.MaximizeFlags.BOTH);
            await sleep(2000);
            const afterUnmaximize = this._layoutOf(manager, selfMaximized);
            afterUnmaximize.tree.layout(this._workArea());
            report.check('需求6 · 取消最大化后窗口铺满自己的格子',
                selfMaximized.get_maximize_flags() === 0 && !selfMaximized.minimized &&
                sameRect(rect(selfMaximized), afterUnmaximize.tree.rectFor(selfMaximized)),
                `${fmt(rect(selfMaximized))} 期望 ${fmt(afterUnmaximize.tree.rectFor(selfMaximized))}`);
        } else {
            report.check('需求6 · 应用启动时自己最大化的窗口会被取消并平铺', false, '客户端没打开');
        }

        await this._spawnClient('W8', 500, 300, ['--dialog']);
        await sleep(2500);
        const dialogWindow = global.display.list_all_windows()
            .find(window => this._title(window) === 'W8-dialog');
        if (dialogWindow) {
            const anyTiled = this._layoutOf(manager, dialogWindow ?? w1);
            anyTiled.tree.layout(this._workArea());
            const dialogCell = anyTiled.tree.rectFor(dialogWindow);
            report.check('对话框 · 不进入平铺布局（保持 mutter 给的位置）',
                anyTiled.tree.findLeaf(dialogWindow) === null &&
                (!dialogCell || !sameRect(rect(dialogWindow), dialogCell)),
                `在布局里=${anyTiled.tree.findLeaf(dialogWindow) !== null} ${fmt(rect(dialogWindow))}`);
        } else {
            report.check('对话框 · 不进入平铺布局', false, '没有找到对话框窗口');
        }

        /* ---------------- 文件夹选择器这类「迟到的对话框」 ---------------- */
        const beforeChooser = new Set(global.display.list_all_windows());
        await this._spawnClient('W9', 500, 300, ['--file-dialog']);
        await sleep(4500);
        const chooser = global.display.list_all_windows()
            .filter(window => !beforeChooser.has(window) && this._title(window) !== 'W9')
            .pop();
        const chooserParent = global.display.list_all_windows()
            .find(window => this._title(window) === 'W9');
        if (chooser) {
            const chooserLayout = this._layoutOf(manager, chooser);
            chooserLayout.tree.layout(this._workArea());
            report.check('文件选择器 · 不参与平铺（即使父窗口关系是事后接上的）',
                chooserLayout.tree.findLeaf(chooser) === null,
                `在布局里=${chooserLayout.tree.findLeaf(chooser) !== null} ${fmt(rect(chooser))}`);
            report.check('文件选择器 · 打开它不会把父窗口留在最小化状态',
                !!chooserParent && !chooserParent.minimized &&
                chooserLayout.tree.findLeaf(chooserParent) !== null,
                chooserParent
                    ? `parent.minimized=${chooserParent.minimized} ` +
                      `在布局里=${chooserLayout.tree.findLeaf(chooserParent) !== null}`
                    : '没有找到父窗口');
        } else {
            report.check('文件选择器 · 不参与平铺（即使父窗口关系是事后接上的）', false,
                '没有等到文件选择器窗口（环境里可能没有 portal，也回退不了）');
        }

        /* ---------------- 需求 7：移动桌面 ---------------- */
        const workspaceManager = global.workspace_manager;
        while (workspaceManager.get_n_workspaces() < 2)
            workspaceManager.append_new_workspace(false, global.get_current_time());
        await sleep(1200);
        const blankWorkspace = workspaceManager.get_workspace_by_index(1);
        const mover = [w1, w2, w3].filter(Boolean).find(w => !w.minimized);
        if (mover) {
            mover.change_workspace(blankWorkspace);
            await sleep(2000);
            const blankArea = blankWorkspace.get_work_area_for_monitor(mover.get_monitor());
            report.check('需求7 · 移到空白桌面 → 铺满该桌面（不被最小化）',
                !mover.minimized &&
                sameRect(rect(mover), {
                    x: blankArea.x, y: blankArea.y,
                    width: blankArea.width, height: blankArea.height,
                }),
                `minimized=${mover.minimized} ${fmt(rect(mover))}`);

            mover.change_workspace(workspaceManager.get_workspace_by_index(0));
            await sleep(2000);
            const backLayout = this._layoutOf(manager, mover);
            backLayout.tree.layout(this._workArea());
            report.check('需求7 · 移回非空白桌面 → 参与平铺（不被最小化）',
                !mover.minimized && backLayout.tree.findLeaf(mover) !== null &&
                sameRect(rect(mover), backLayout.tree.rectFor(mover)),
                `minimized=${mover.minimized} ${fmt(rect(mover))} ` +
                `期望 ${fmt(backLayout.tree.rectFor(mover))}`);
            const moverCell = backLayout.tree.rectFor(mover);
            const sameColumn = backLayout.tree.windows()
                .filter(w => w !== mover)
                .map(w => backLayout.tree.rectFor(w))
                .filter(r => r && r.x === moverCell.x && r.width === moverCell.width);
            report.check('需求7 · 挪过来的窗口是上下平铺（同一列里的新一行，不是新分栏）',
                sameColumn.length > 0,
                `mover=${fmt(moverCell)} 同列窗口=${sameColumn.map(fmt).join(' ') || '无'}`);
        } else {
            report.check('需求7 · 移动桌面', false, '没有可用的窗口');
        }

        /* ---------------- 需求 2：关掉第二个窗口不会自动把上一个窗口调回来 ---------------- */
        while (workspaceManager.get_n_workspaces() < 3)
            workspaceManager.append_new_workspace(false, global.get_current_time());
        await sleep(1200);
        const freshWorkspace = workspaceManager.get_workspace_by_index(2);
        freshWorkspace.activate(global.get_current_time());
        await sleep(1200);

        const r1 = await this._spawnClient('R1');
        await sleep(2000);
        // 先让 R1 最大化：打开 R2 时焦点切走，R1 应该只是取消最大化（不要把最大化带给 R2）
        if (r1) {
            r1.maximize(Meta.MaximizeFlags.BOTH);
            await sleep(1500);
        }
        const r2 = r1 ? await this._spawnClient('R2') : null;
        await sleep(2500);
        if (r1 && r2) {
            report.check('需求2 · 打开新窗口时原来最大化的窗口只取消最大化',
                r1.get_maximize_flags() === 0 && !r1.minimized &&
                r2.get_maximize_flags() === 0 && !r2.minimized,
                `r1.flags=${r1.get_maximize_flags()} r2.flags=${r2.get_maximize_flags()}`);
            const freshLayout = this._layoutOf(manager, r2);
            freshLayout.tree.layout(freshWorkspace.get_work_area_for_monitor(r2.get_monitor()));
            report.check('需求2 · 两个窗口都参与平铺、互不重叠',
                freshLayout.tree.windows().length === 2 &&
                freshLayout.tree.findLeaf(r1) !== null &&
                freshLayout.tree.findLeaf(r2) !== null,
                `windows=${freshLayout.tree.windows().length}`);
        } else {
            report.check('需求2 · 打开新窗口不顶替、不最小化原来的窗口', false,
                '客户端没有打开成功');
        }

        /* ---------------- 收尾：不变量与截图 ---------------- */
        const workspace = workspaceManager.get_workspace_by_index(0);
        const visibleOnWorkspace = workspace.list_windows()
            .filter(w => w.get_window_type?.() === Meta.WindowType.NORMAL && !w.minimized &&
                !(w.get_transient_for?.() ?? null) && !(w.is_attached_dialog?.() ?? false) &&
                !(w.is_modal?.() ?? false));
        const rects = visibleOnWorkspace.map(rect);
        let overlaps = 0;
        for (let i = 0; i < rects.length; i++) {
            for (let j = i + 1; j < rects.length; j++) {
                if (overlap(rects[i], rects[j]))
                    overlaps++;
            }
        }
        report.check('不变量 · 第一个桌面上可见窗口互不重叠', overlaps === 0,
            `可见窗口 ${rects.length} 个，重叠 ${overlaps} 对`);

        /* ---------------- 需求 7：最大化 / 最小化的窗口挪桌面保持状态 ---------------- */
        const keepWsA = workspaceManager.get_workspace_by_index(0);
        const keepWsB = workspaceManager.get_workspace_by_index(1);
        const keepMax = [w1, w2, w3].find(w => w && !w.minimized);
        if (keepMax) {
            keepMax.activate(global.get_current_time());
            await sleep(1500);
            keepMax.maximize(Meta.MaximizeFlags.BOTH);
            await sleep(1500);
            keepMax.change_workspace(keepWsB);
            await sleep(2200);
            report.check('需求7 · 最大化的窗口挪到别的桌面后仍然最大化',
                keepMax.get_maximize_flags() === Meta.MaximizeFlags.BOTH && !keepMax.minimized,
                `flags=${keepMax.get_maximize_flags()} minimized=${keepMax.minimized}`);

            // 在那个桌面上切到普通窗口：挪进来的最大化窗口应当取消最大化并重新参与平铺
            const keepTiled = keepWsB.list_windows()
                .find(window => window !== keepMax && !window.minimized);
            if (keepTiled) {
                keepTiled.activate(global.get_current_time());
                await sleep(2500);
                const keepLayout = this._layoutOf(manager, keepTiled);
                keepLayout.tree.layout(this._workArea());
                report.check('需求7 · 切走焦点后，挪进来的最大化窗口取消最大化并回到平铺',
                    keepMax.get_maximize_flags() === 0 &&
                    keepLayout.tree.findLeaf(keepMax) !== null,
                    `flags=${keepMax.get_maximize_flags()} ` +
                    `在布局里=${keepLayout.tree.findLeaf(keepMax) !== null}`);
            } else {
                report.check('需求7 · 切走焦点后，挪进来的最大化窗口取消最大化并回到平铺', false,
                    '那个桌面上没有普通窗口可切');
            }

            keepMax.minimize();
            keepMax.change_workspace(keepWsA);
            await sleep(2200);
            report.check('需求7 · 最小化的窗口挪到别的桌面后仍然最小化',
                keepMax.minimized === true, `minimized=${keepMax.minimized}`);
            keepMax.unminimize();
            await sleep(1500);
        } else {
            report.check('需求7 · 最大化 / 最小化的窗口挪桌面保持状态', false, '没有可用的窗口');
        }

        /* ---------------- 分栏等宽：插入时、以及删除分栏之后 ---------------- */
        const colWs = workspaceManager.get_workspace_by_index(2);
        colWs.activate(global.get_current_time());
        await sleep(1200);
        const c1 = await this._spawnClient('C1');
        await sleep(1800);
        const c2 = c1 ? await this._spawnClient('C2') : null;
        await sleep(1800);
        const c3 = c2 ? await this._spawnClient('C3') : null;
        await sleep(1800);
        if (c1 && c2 && c3) {
            // 用拖放做出三个分栏
            const colArea = this._workArea();
            manager.dropAt(c2, colArea.x + 4, colArea.y + 40);
            await sleep(1500);
            manager.dropAt(c3, colArea.x + 4, colArea.y + 40);
            await sleep(1800);
            const colLayout = this._layoutOf(manager, c3);
            colLayout.tree.layout(colArea);
            const columnWidths = () => [c1, c2, c3]
                .filter(window => colLayout.tree.findLeaf(window))
                .map(window => colLayout.tree.rectFor(window).width);
            const inserted = columnWidths();
            report.check('分栏 · 插入新分栏后所有分栏等宽',
                colLayout.tree.columnCount() === 3 &&
                Math.max(...inserted) - Math.min(...inserted) <= 1,
                `宽度=${inserted.join('/')} 列数=${colLayout.tree.columnCount()}`);

            // 关掉独占一列的那个窗口 → 剩下的分栏重新均分
            const solo = [c1, c2, c3].find(window =>
                colLayout.tree.findLeaf(window) &&
                colLayout.tree.columnRegion(colLayout.tree.findLeaf(window)) ===
                    colLayout.tree.findLeaf(window));
            if (solo) {
                solo.delete(global.get_current_time());
                await sleep(2000);
                colLayout.tree.layout(colArea);
                const remaining = columnWidths();
                report.check('分栏 · 删除一个分栏之后剩下的分栏等宽',
                    colLayout.tree.columnCount() === 2 &&
                    Math.max(...remaining) - Math.min(...remaining) <= 1,
                    `宽度=${remaining.join('/')} 列数=${colLayout.tree.columnCount()}`);
            } else {
                report.check('分栏 · 删除一个分栏之后剩下的分栏等宽', false, '没有独占一列的窗口');
            }
        } else {
            report.check('分栏 · 插入新分栏后所有分栏等宽', false, '客户端没有全部打开成功');
        }

        /* ---------------- 全屏只是暂时状态：退出后要回到平铺 ---------------- */
        const fullscreenClient = await this._spawnClient('W11');
        await sleep(2000);
        if (fullscreenClient) {
            const fsLayout = this._layoutOf(manager, fullscreenClient);
            fsLayout.tree.layout(this._workArea());
            const fsCellBefore = fsLayout.tree.rectFor(fullscreenClient);
            fullscreenClient.make_fullscreen();
            await sleep(3000);   // 覆盖一次兜底复核（每 2 秒一次）
            report.check('全屏 · 全屏期间不会被驱逐出平铺',
                fsLayout.tree.findLeaf(fullscreenClient) !== null,
                `在布局里=${fsLayout.tree.findLeaf(fullscreenClient) !== null}`);
            fullscreenClient.unmake_fullscreen();
            await sleep(2500);
            fsLayout.tree.layout(this._workArea());
            report.check('全屏 · 退出全屏后回到平铺（还是原来那个格子）',
                fsLayout.tree.findLeaf(fullscreenClient) !== null &&
                !fullscreenClient.minimized &&
                sameRect(rect(fullscreenClient), fsLayout.tree.rectFor(fullscreenClient)),
                `${fmt(rect(fullscreenClient))} 期望 ${fmt(fsLayout.tree.rectFor(fullscreenClient))} ` +
                `（全屏前 ${fmt(fsCellBefore)}）`);
        } else {
            report.check('全屏 · 退出全屏后回到平铺', false, '客户端没有打开成功');
        }

        /* ---------------- 动态增删桌面：布局不能串位 ---------------- */
        while (workspaceManager.get_n_workspaces() < 5)
            workspaceManager.append_new_workspace(false, global.get_current_time());
        await sleep(1500);
        const lastWorkspace = workspaceManager.get_workspace_by_index(4);
        lastWorkspace.activate(global.get_current_time());
        await sleep(1200);
        const shiftedClient = await this._spawnClient('W10');
        await sleep(2000);
        const middleWorkspace = workspaceManager.get_workspace_by_index(3);
        const removed = middleWorkspace.list_windows().length === 0 &&
            workspaceManager.remove_workspace(middleWorkspace, global.get_current_time());
        await sleep(2000);
        if (!removed) {
            report.note('动态桌面用例跳过：mutter 没有删掉中间那个空桌面');
        } else if (shiftedClient) {
            const shiftedLayout = this._layoutOf(manager, shiftedClient);
            shiftedLayout.tree.layout(this._workArea());
            report.check('动态桌面 · 删掉中间空桌面后，移位桌面的窗口仍在自己布局里',
                shiftedLayout.tree.findLeaf(shiftedClient) !== null &&
                sameRect(rect(shiftedClient), shiftedLayout.tree.rectFor(shiftedClient)),
                `${fmt(rect(shiftedClient))} 期望 ${fmt(shiftedLayout.tree.rectFor(shiftedClient))}`);
        } else {
            report.check('动态桌面 · 删掉中间空桌面后，移位桌面的窗口仍在自己布局里', false,
                '客户端没有打开成功');
        }

        /* ---------------- 可选：没有非最小化窗口时自动进入概览 ---------------- */
        extension.getSettings().set_boolean('show-overview-when-empty', true);
        const overviewWorkspace = workspaceManager.get_workspace_by_index(1);
        overviewWorkspace.activate(global.get_current_time());
        await sleep(1500);
        for (const window of overviewWorkspace.list_windows())
            window.minimize();
        await sleep(2500);
        report.check('概览 · 桌面上没有非最小化窗口时自动进入概览',
            Main.overview.visible === true, `visible=${Main.overview.visible}`);
        Main.overview.hide();
        await sleep(1200);
        extension.getSettings().reset('show-overview-when-empty');

        if (SCREENSHOT)
            await this._screenshot(SCREENSHOT);

        report.write();
    }

    async _screenshot(path) {
        try {
            const shooter = new Shell.Screenshot();
            await new Promise(resolve => {
                try {
                    shooter.screenshot(false, path, () => resolve());
                } catch (error) {
                    this._report.note(`截图失败: ${error}`);
                    resolve();
                }
            });
            this._report.note(`截图已保存: ${path}`);
        } catch (error) {
            this._report.note(`截图不可用: ${error}`);
        }
    }
}
