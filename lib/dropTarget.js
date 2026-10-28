// SPDX-License-Identifier: MIT
/*
 * dropTarget.js —— 需求 4 的落点判定（纯逻辑，可直接用 node 测试）。
 *
 * 空间布局是「屏幕 → 列 → 行」两层：根节点是整个工作区（屏幕去掉上方面板与底部图标
 * 停靠区占用的空间），第一层切成若干「分栏」（列，每列占满整列高度），第二层在每个
 * 分栏内部竖着堆叠窗口（行）。**行里不能再切出列** —— 所以横向的插入一律发生在列
 * 一级：让相邻的那一整列腾出一半，被拖动的窗口成为一整列。
 *
 * 指针位置对应的动作优先级：
 *   1. 桌面上没有其它窗口            → fill：铺满整个工作区（需求 1 / 需求 7）
 *   2. 窗口之间的分界线（阈值内）     → between：竖线 → 插出新分栏；横线 → 插出新的一行
 *   3. 另一个窗口格子内、贴着某条边   → edge：贴左/右边 → 在旁边插出新分栏；
 *                                      贴上/下边 → 在这个分栏里插出新一行（需求 4）
 *   4. 另一个窗口格子内部            → swap：交换两个窗口的位置与大小（需求 4）
 *   5. 指针不在任何格子里            → 贴着工作区边时按最近的格子处理，否则 none
 *
 * planDrop() 直接返回「执行后」的布局树与预览矩形，保证预览和最终结果完全一致：
 * 判定在「仍包含被拖动窗口」的副本上进行（用户看到的就是这个），执行则发生在
 * 「已移除被拖动窗口」的副本上，因此不会把窗口插到它自己旁边。
 */

export const DROP_NONE = 'none';
export const DROP_FILL = 'fill';
export const DROP_EDGE = 'edge';
export const DROP_BETWEEN = 'between';
export const DROP_SWAP = 'swap';

/** 「插到两个窗口之间」时高亮间隙的粗细（像素）。 */
export const GAP_PREVIEW_THICKNESS = 6;

function clamp(value, lo, hi) {
    return Math.max(lo, Math.min(hi, value));
}

/**
 * 「贴到某条边上插入」时高亮的间隙：沿这条边的一条细长条。
 * 目标窗口贴着屏幕边缘时，这条间隙正好落在屏幕边缘上。
 */
function gapRectAt(rect, side, gapThickness = GAP_PREVIEW_THICKNESS) {
    if (!rect)
        return null;
    const thickness = gapThickness;
    if (side === 'left' || side === 'right') {
        return {
            x: Math.round((side === 'left' ? rect.x : rect.x + rect.width) - thickness / 2),
            y: Math.round(rect.y),
            width: thickness,
            height: Math.max(1, Math.round(rect.height)),
        };
    }
    return {
        x: Math.round(rect.x),
        y: Math.round((side === 'top' ? rect.y : rect.y + rect.height) - thickness / 2),
        width: Math.max(1, Math.round(rect.width)),
        height: thickness,
    };
}

/** 指针是否处于某个屏幕边缘的吸附范围内；返回 'left'|'right'|'top'|'bottom'|null。 */
export function edgeForPoint(area, [px, py], threshold) {
    if (!area)
        return null;
    if (px < area.x - threshold || px > area.x + area.width + threshold)
        return null;
    if (py < area.y - threshold || py > area.y + area.height + threshold)
        return null;

    const distances = {
        left: Math.abs(px - area.x),
        right: Math.abs(px - (area.x + area.width)),
        top: Math.abs(py - area.y),
        bottom: Math.abs(py - (area.y + area.height)),
    };

    let best = null;
    for (const [edge, distance] of Object.entries(distances)) {
        if (distance <= threshold && (!best || distance < best.distance))
            best = {edge, distance};
    }
    return best ? best.edge : null;
}

/**
 * 指针停在某个格子的哪条边上（阈值内）；返回 'left'|'right'|'top'|'bottom'|null。
 * 落在角落时取更近的那条边。
 */
export function sideForPoint(rect, [px, py], threshold) {
    if (!rect)
        return null;
    // 允许 1 像素的取整误差，但不接受明显落在格子外面的点
    if (px < rect.x - 1 || px > rect.x + rect.width + 1)
        return null;
    if (py < rect.y - 1 || py > rect.y + rect.height + 1)
        return null;

    const distances = [
        ['left', px - rect.x],
        ['right', rect.x + rect.width - px],
        ['top', py - rect.y],
        ['bottom', rect.y + rect.height - py],
    ];

    let best = null;
    for (const [side, distance] of distances) {
        const clamped = Math.max(0, distance);
        if (!best || clamped < best.distance)
            best = {side, distance: clamped};
    }
    return best && best.distance <= threshold ? best.side : null;
}

/** 离指针最近的那条「两个相邻窗口之间的分界线」。 */
export function nearestBoundary(tree, [px, py], threshold) {
    let best = null;
    for (const boundary of tree.boundaries()) {
        const perpendicular = boundary.orientation === 'h'
            ? Math.abs(px - boundary.position)
            : Math.abs(py - boundary.position);
        if (perpendicular > threshold)
            continue;

        const along = boundary.orientation === 'h' ? py : px;
        if (along < boundary.from - threshold || along > boundary.to + threshold)
            continue;

        if (!best || perpendicular < best.perpendicular)
            best = {boundary, perpendicular};
    }
    return best ? best.boundary : null;
}

/** 指针落在哪个窗口上。 */
export function leafForPoint(tree, [px, py]) {
    for (const leaf of tree.leaves()) {
        const rect = tree.nodeRect(leaf);
        if (!rect)
            continue;
        if (px >= rect.x && px < rect.x + rect.width && py >= rect.y && py < rect.y + rect.height)
            return leaf;
    }
    return null;
}

/**
 * 离指针最近的窗口格子（指针落在工作区之外时使用）。
 * @param {object|null} exclude 排除的窗口（拖动的那个窗口本身）
 */
export function nearestLeaf(tree, [px, py], exclude = null) {
    let best = null;
    for (const leaf of tree.leaves()) {
        if (exclude && leaf.window === exclude)
            continue;
        const rect = tree.nodeRect(leaf);
        if (!rect)
            continue;
        const dx = Math.max(rect.x - px, 0, px - (rect.x + rect.width));
        const dy = Math.max(rect.y - py, 0, py - (rect.y + rect.height));
        const distance = dx * dx + dy * dy;
        if (!best || distance < best.distance)
            best = {leaf, distance};
    }
    return best ? best.leaf : null;
}

/**
 * 计算落点方案。
 *
 * @param {object}   options
 * @param {object}   options.tree      当前布局树（LayoutTree，必须已经 layout() 过）
 * @param {object}   options.window      被拖动的窗口
 * @param {number[]} options.pointer     [x, y] 指针位置
 * @param {number}   options.threshold   边缘/分界线吸附阈值
 * @param {number}   options.insertShare 新窗口占「被切分格子」的比例（默认 0.5，即平分）
 * @returns {{action: string, tree: object, previewRect: object|null, detail: object|null}}
 */
export function planDrop({
    tree,
    window,
    pointer,
    threshold = 40,
    insertShare = 0.5,
    gapThickness = GAP_PREVIEW_THICKNESS,
}) {
    const area = tree.area;
    if (!area)
        return {action: DROP_NONE, tree, previewRect: null, detail: null};

    const share = clamp(insertShare, 0.05, 0.95);
    const previewThickness = Math.max(1, Math.round(gapThickness));

    const current = tree.clone();
    current.layout(area);
    const inTree = !!current.findLeaf(window);

    const base = tree.clone();
    if (inTree)
        base.removeWindow(window);
    base.layout(area);

    // 桌面上没有其它窗口：铺满屏幕（需求 1 / 需求 7 的空白桌面分支）
    if (base.isEmpty) {
        base.setSingleWindow(window);
        base.layout(area);
        return {
            action: DROP_FILL,
            tree: base,
            previewRect: {x: area.x, y: area.y, width: area.width, height: area.height},
            detail: null,
        };
    }

    const under = leafForPoint(current, pointer);

    // 0) 屏幕左右（竖）边：**无论指针在这条边的哪个高度**（贴着某条行分界线、
    //    甚至跑到面板 / 停靠区那一段）都按「在这一侧插出一个新分栏」处理。
    //    否则指针正好落在行分界线附近时会被判定成「插新行」，和屏幕边缘冲突。
    const verticalEdge = Math.abs(pointer[0] - area.x) <= threshold ? 'left'
        : Math.abs(pointer[0] - (area.x + area.width)) <= threshold ? 'right'
            : null;
    if (verticalEdge) {
        const clampedY = clamp(pointer[1], area.y + 1, area.y + area.height - 1);
        const edgeX = verticalEdge === 'left' ? area.x + 1 : area.x + area.width - 1;
        // 贴着这条边的那个窗口；如果它就是被拖动的窗口（拖的是最外侧那一栏），
        // 换同一个分栏里的另一行 / 最近的另一个窗口当参照 —— 否则「拖到竖边
        // 任何位置都能平铺」在拖最外侧窗口时会失效
        let edgeLeaf = leafForPoint(current, [edgeX, clampedY]);
        if (!edgeLeaf || edgeLeaf.window === window)
            edgeLeaf = nearestLeaf(current, [edgeX, clampedY], window);
        const target = edgeLeaf ? base.findLeaf(edgeLeaf.window) : null;
        if (target) {
            const targetRect = current.nodeRect(edgeLeaf);
            const before = verticalEdge === 'left';
            base.splitLeafNode(target, window, {
                before,
                ratio: before ? share : 1 - share,
                orientation: 'h',
            });
            base.equalizeColumns();   // 新分栏：所有分栏等宽
            base.layout(area);
            // 拖到屏幕竖边：高亮**整条边框**（整个屏幕高度），而不是只标出一段
            const thickness = previewThickness;
            const edgeGap = {
                x: Math.round((verticalEdge === 'left' ? area.x : area.x + area.width) - thickness / 2),
                y: Math.round(area.y),
                width: thickness,
                height: Math.max(1, Math.round(area.height)),
            };
            return {
                action: DROP_EDGE,
                tree: base,
                previewRect: base.rectFor(window),
                gapRect: edgeGap,
                detail: {
                    edge: verticalEdge,
                    neighbor: edgeLeaf.window,
                    unit: 'column',
                    screenEdge: true,
                },
            };
        }
    }

    // 屏幕上下（横）边那一条带（面板 / 停靠区所在的位置）里：
    //   · 这一段对着**被拖动窗口自己那一栏** → 什么都不做（不插入、不交换，
    //     窗口留在原地）；
    //   · 对着别的分栏 → 照常可以移过去（插新行 / 交换）。
    const inHorizontalBand = Math.abs(pointer[1] - area.y) <= threshold ||
        Math.abs(pointer[1] - (area.y + area.height)) <= threshold;
    let atOwnHorizontalEdge = false;
    if (inHorizontalBand) {
        const clampedY = clamp(pointer[1], area.y + 1, area.y + area.height - 1);
        const clampedX = clamp(pointer[0], area.x + 1, area.x + area.width - 1);
        const underPointer = leafForPoint(current, [clampedX, clampedY]);
        const pointerColumn = underPointer ? current.columnRegion(underPointer) : null;
        const draggedLeaf = inTree ? current.findLeaf(window) : null;
        const draggedColumn = draggedLeaf ? current.columnRegion(draggedLeaf) : null;
        atOwnHorizontalEdge = !!pointerColumn && !!draggedColumn && pointerColumn === draggedColumn;
    }

    // 屏幕上下横边、对着**被拖动窗口自己那一栏**：就在本栏里正常平铺 ——
    // 把它移到这一栏的顶部 / 底部（不是插新分栏，也不会跑到别的分栏去）。
    if (atOwnHorizontalEdge) {
        const leaf = current.findLeaf(window);
        const column = leaf ? current.columnRegion(leaf) : null;
        const siblings = [];
        const collect = node => {
            if (!node)
                return;
            if (node.kind === 'leaf') {
                if (node.window !== window)
                    siblings.push(node.window);
                return;
            }
            collect(node.first);
            collect(node.second);
        };
        if (column)
            collect(column);
        const toTop = pointer[1] <= area.y + area.height / 2;
        const survivor = siblings.length
            ? (toTop ? siblings[0] : siblings[siblings.length - 1])
            : null;
        const target = survivor ? base.findLeaf(survivor) : null;
        if (target) {
            const columnNode = base.columnRegion(target);
            base.splitNode(columnNode, window, {
                before: toTop,
                ratio: toTop ? share : 1 - share,
                orientation: 'v',
            });
            base.layout(area);
            // 这一栏的窗口数没变（只是换了顺序）：按现行规则把行高均分
            const inserted = base.findLeaf(window);
            if (inserted)
                base.equalizeRows(base.columnRegion(inserted));
            base.layout(area);
            const columnRect = current.nodeRect(column);
            return {
                action: DROP_EDGE,
                tree: base,
                previewRect: base.rectFor(window),
                gapRect: gapRectAt(columnRect, toTop ? 'top' : 'bottom', previewThickness),
                detail: {
                    edge: toTop ? 'top' : 'bottom',
                    neighbor: survivor,
                    unit: 'row',
                    sameColumn: true,
                },
            };
        }
        return {action: DROP_NONE, tree, previewRect: null, detail: null};
    }

    // 1) 落在分界线上（需求 4）：让分界线某一侧紧邻的那一个「单位」腾出一半
    //
    //    · 两个分栏之间的竖线（'h'）：单位是整列窗口 → 插出一个新分栏（全高）
    //    · 分栏内部的横线（'v'）：单位是一个窗口 → 在分栏里插出新的一行
    //
    //    横向插入必须作用于整列：如果只切指针下面那一行，分栏里就会出现宽度不
    //    一致的窗口 —— 这违反「行里不能再切出列」的结构约束。
    const boundary = nearestBoundary(current, pointer, threshold);
    if (boundary) {
        const perpendicular = boundary.orientation === 'h'
            ? pointer[0] - boundary.position
            : pointer[1] - boundary.position;
        // 取分界线两侧真正相邻的窗口（一条贯穿的分界线沿线可能挨着好几个窗口）
        const along = boundary.orientation === 'h' ? pointer[1] : pointer[0];
        const adjacent = current.leavesAtBoundary(boundary, along);
        // 竖线（'h'）相邻的单位是整列窗口，横线（'v'）相邻的单位就是一个窗口
        const unitFor = leaf => boundary.orientation === 'h' ? current.columnRegion(leaf) : leaf;
        const beforeUnit = unitFor(adjacent.before);
        const afterUnit = unitFor(adjacent.after);

        // 指针偏向哪一侧，就让那一侧的单位让位；正好压在线上时让较小的那个让位
        const beforeSide = perpendicular !== 0
            ? perpendicular < 0
            : areaOf(current, beforeUnit) <= areaOf(current, afterUnit);

        const neighbourUnit = beforeSide ? beforeUnit : afterUnit;
        const neighbourLeaf = beforeSide ? adjacent.before : adjacent.after;
        // 被拖动窗口腾出的空间可能让这一列塌缩成一个窗口，此时直接切那个窗口
        const target = base.findNodeById(neighbourUnit.id) ?? base.findLeaf(neighbourLeaf.window);
        if (target) {
            // 被拖动的窗口贴着分界线：邻居在左/上时排到它后面，邻居在右/下时排到它前面
            const insertBefore = !beforeSide;
            base.splitNode(target, window, {
                before: insertBefore,
                ratio: insertBefore ? share : 1 - share,
                orientation: boundary.orientation,
            });
            if (boundary.orientation === 'h')
                base.equalizeColumns(); // 新分栏：所有分栏等宽
            base.layout(area);
            // 「插到两个窗口之间」的预览：直接把它们之间的间隙高亮出来
            const thickness = previewThickness;
            const gapRect = boundary.orientation === 'h'
                ? {
                    x: boundary.position - thickness / 2,
                    y: boundary.from,
                    width: thickness,
                    height: Math.max(1, boundary.to - boundary.from),
                }
                : {
                    x: boundary.from,
                    y: boundary.position - thickness / 2,
                    width: Math.max(1, boundary.to - boundary.from),
                    height: thickness,
                };
            return {
                action: DROP_BETWEEN,
                tree: base,
                previewRect: base.rectFor(window),
                gapRect,
                detail: {
                    side: beforeSide ? 'before' : 'after',
                    insertBefore,
                    share,
                    column: boundary.orientation === 'h',
                },
            };
        }
    }

    // 2) 落在另一个窗口的格子上
    if (under && under.window !== window) {
        const target = base.findLeaf(under.window);
        const underRect = current.nodeRect(under);
        const side = sideForPoint(underRect, pointer, threshold);
        // 贴着某条边 → 与它平铺（需求 4）：
        //   左/右边 → 在它这一列旁边插出一个新分栏（整列让出一半，宽度不会被拆散）
        //   上/下边 → 在它这一列里插出新的一行
        // 横向切分由 splitNode() 保证作用在整列上，所以这里直接切它所在的格子即可。
        if (side && target) {
            const axis = side === 'left' || side === 'right' ? 'h' : 'v';
            const before = side === 'left' || side === 'top';
            base.splitLeafNode(target, window, {
                before,
                ratio: before ? share : 1 - share,
                orientation: axis,
            });
            if (axis === 'h')
                base.equalizeColumns(); // 新分栏：所有分栏等宽
            base.layout(area);
            // 贴着某条边插入 = 插在新窗口和它之间：高亮那条间隙（贴到屏幕边缘时
            // 就是屏幕边缘那一条），而不是画一整个新格子
            return {
                action: DROP_EDGE,
                tree: base,
                previewRect: base.rectFor(window),
                gapRect: gapRectAt(underRect, side, previewThickness),
                detail: {edge: side, neighbor: under.window, unit: axis === 'h' ? 'column' : 'row'},
            };
        }

        // 格子内部 → 交换位置（需求 4）
        if (inTree) {
            const next = tree.clone();
            next.layout(area);
            if (next.swapWindows(window, under.window)) {
                next.layout(area);
                return {
                    action: DROP_SWAP,
                    tree: next,
                    previewRect: next.rectFor(window),
                    detail: {target: under.window},
                };
            }
        }
    }

    // 3) 贴着屏幕边缘松手：无论指针落在哪个位置都要能平铺 ——
    //    包括指针还压在**被拖窗口自己**的格子上（例如把贴着屏幕边缘的窗口
    //    再拖到同一条边上，此时 under 就是它自己，不能因为「落在自己格子里」
    //    就什么都不做）。按最近的**其它**窗口的对应边处理。
    const edge = edgeForPoint(area, pointer, threshold);
    if ((!under || under.window === window) && edge) {
        const nearby = nearestLeaf(current, pointer, window);
        // 指针还在自己原来的格子里 → 放回原处，不做任何改动
        if (under?.window === window)
            return {action: DROP_NONE, tree, previewRect: null, detail: null};
        const target = nearby && nearby.window !== window ? base.findLeaf(nearby.window) : null;
        if (target) {
            const axis = edge === 'left' || edge === 'right' ? 'h' : 'v';
            const before = edge === 'left' || edge === 'top';
            const nearbyRect = current.nodeRect(nearby);
            base.splitLeafNode(target, window, {
                before,
                ratio: before ? share : 1 - share,
                orientation: axis,
            });
            if (axis === 'h')
                base.equalizeColumns(); // 新分栏：所有分栏等宽
            base.layout(area);
            return {
                action: DROP_EDGE,
                tree: base,
                previewRect: base.rectFor(window),
                gapRect: gapRectAt(nearbyRect, edge, previewThickness),
                detail: {edge, neighbor: nearby.window, unit: axis === 'h' ? 'column' : 'row'},
            };
        }
    }

    // 4) 其它位置：保持原状（松手后回到原本的格子）
    return {action: DROP_NONE, tree, previewRect: null, detail: null};
}

function areaOf(tree, leaf) {
    const rect = tree.nodeRect(leaf);
    return rect ? rect.width * rect.height : 0;
}
