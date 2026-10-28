// 运行方式（在扩展根目录）：node --test
import test from 'node:test';
import assert from 'node:assert/strict';

import {LayoutTree} from '../lib/layoutTree.js';
import {
    planDrop,
    edgeForPoint,
    sideForPoint,
    nearestBoundary,
    leafForPoint,
    nearestLeaf,
    DROP_EDGE,
    DROP_BETWEEN,
    DROP_SWAP,
    DROP_NONE,
    DROP_FILL,
    GAP_PREVIEW_THICKNESS,
} from '../lib/dropTarget.js';

const AREA = {x: 0, y: 0, width: 1200, height: 800};
const WIDE = {x: 0, y: 0, width: 1600, height: 600};
const THRESHOLD = 40;

/** 两个窗口并排：B | A */
function twoWindows({gap = 0, area = AREA} = {}) {
    const layout = new LayoutTree({gap, minSize: 100});
    layout.setSingleWindow('B');
    layout.layout(area);
    layout.splitWindow('B', 'A', {before: false, ratio: 0.5, orientation: 'h'});
    layout.layout(area);
    return layout;
}

/** 三个窗口并排：P | Z | X（P 是要被拖动的那个） */
function threeWindows({gap = 0, area = WIDE} = {}) {
    const layout = new LayoutTree({gap, minSize: 100});
    layout.setSingleWindow('P');
    layout.layout(area);
    layout.splitWindow('P', 'Z', {before: false, ratio: 0.5, orientation: 'h'});
    layout.layout(area);
    layout.splitWindow('Z', 'X', {before: false, ratio: 0.5, orientation: 'h'});
    layout.layout(area);
    return layout;
}

function assertNoOverlap(tree, area) {
    const rects = tree.windows().map(window => tree.rectFor(window));
    for (const rect of rects) {
        assert.ok(rect.x >= area.x && rect.y >= area.y, '窗口超出工作区左上角');
        assert.ok(rect.x + rect.width <= area.x + area.width, '窗口超出工作区右边');
        assert.ok(rect.y + rect.height <= area.y + area.height, '窗口超出工作区下边');
    }
    for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
            const a = rects[i];
            const b = rects[j];
            const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
            const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
            assert.ok(overlapX <= 0 || overlapY <= 0, '两个窗口重叠了');
        }
    }
}

/**
 * 结构约束：布局只有「列 → 行」两层，行里不能再切出列。
 * 也就是「行」（'v'）里面不允许再出现「列」（'h'）。
 */
function assertTwoLevel(tree) {
    const walk = (node, insideRows) => {
        if (!node || node.kind === 'leaf')
            return;
        const rows = insideRows || node.orientation === 'v';
        assert.ok(!(node.orientation === 'h' && rows), '行里不能再切出列');
        walk(node.first, rows);
        walk(node.second, rows);
    };
    walk(tree.root, false);
}

test('edgeForPoint 正确识别四个边缘（角落取最近的一条边）', () => {
    assert.equal(edgeForPoint(AREA, [5, 400], THRESHOLD), 'left');
    assert.equal(edgeForPoint(AREA, [1195, 400], THRESHOLD), 'right');
    assert.equal(edgeForPoint(AREA, [600, 3], THRESHOLD), 'top');
    assert.equal(edgeForPoint(AREA, [600, 799], THRESHOLD), 'bottom');
    assert.equal(edgeForPoint(AREA, [2, 2], THRESHOLD), 'left');
    assert.equal(edgeForPoint(AREA, [600, 400], THRESHOLD), null);
    assert.equal(edgeForPoint(AREA, [-100, 400], THRESHOLD), null);
});

test('sideForPoint 判断指针贴着格子的哪条边（角落取最近的一条边）', () => {
    const rect = {x: 100, y: 100, width: 400, height: 300};
    assert.equal(sideForPoint(rect, [105, 250], THRESHOLD), 'left');
    assert.equal(sideForPoint(rect, [495, 250], THRESHOLD), 'right');
    assert.equal(sideForPoint(rect, [300, 105], THRESHOLD), 'top');
    assert.equal(sideForPoint(rect, [300, 395], THRESHOLD), 'bottom');
    assert.equal(sideForPoint(rect, [300, 250], THRESHOLD), null); // 中间
    assert.equal(sideForPoint(rect, [700, 250], THRESHOLD), null); // 格子外面
});

test('nearestLeaf 找到离指针最近的格子', () => {
    const layout = twoWindows();
    assert.equal(nearestLeaf(layout, [100, 100]).window, 'B');
    assert.equal(nearestLeaf(layout, [1100, 100]).window, 'A');
    assert.equal(nearestLeaf(layout, [1300, 100]).window, 'A');
});

test('nearestBoundary 只在分界线附近命中', () => {
    const layout = threeWindows();
    assert.ok(nearestBoundary(layout, [800, 300], THRESHOLD));
    assert.ok(nearestBoundary(layout, [1200, 300], THRESHOLD));
    assert.equal(nearestBoundary(layout, [1000, 300], THRESHOLD), null);
    // 分界线覆盖范围之外不命中
    assert.equal(nearestBoundary(layout, [1200, 900], THRESHOLD), null);
});

test('leafForPoint 判断指针落在哪个窗口的格子上', () => {
    const layout = twoWindows();
    assert.equal(leafForPoint(layout, [100, 100]).window, 'B');
    assert.equal(leafForPoint(layout, [1100, 100]).window, 'A');
    assert.equal(leafForPoint(layout, [1100, 900]), null);
});

test('拖到某个窗口的左边缘：在它这一列旁边插出一个新分栏（需求 4）', () => {
    const layout = twoWindows();
    const plan = planDrop({tree: layout, window: 'A', pointer: [10, 400], threshold: THRESHOLD});

    assert.equal(plan.action, DROP_EDGE);
    assert.equal(plan.detail.edge, 'left');
    assert.equal(plan.detail.unit, 'column');
    assert.equal(plan.detail.neighbor, 'B');
    assert.deepEqual(plan.previewRect, {x: 0, y: 0, width: 600, height: 800});
    assert.deepEqual(plan.tree.rectFor('A'), plan.previewRect);
    assert.deepEqual(plan.tree.rectFor('B'), {x: 600, y: 0, width: 600, height: 800});
    assert.deepEqual(plan.tree.windows(), ['A', 'B']);
    assertTwoLevel(plan.tree);
});

test('拖到某个窗口格子的右边缘与下边缘（需求 4）', () => {
    const right = planDrop({
        tree: twoWindows(),
        window: 'B',
        pointer: [1195, 400],
        threshold: THRESHOLD,
    });
    assert.equal(right.action, DROP_EDGE);
    assert.equal(right.detail.edge, 'right');
    assert.equal(right.detail.neighbor, 'A');
    assert.deepEqual(right.tree.rectFor('B'), {x: 600, y: 0, width: 600, height: 800});

    // 指针落在 B 的格子里、贴着它的下边缘：拖的是**别的分栏**里的窗口，
    // 所以仍然在 B 这一栏里插出新行（横边只对「自己被拖出来那一栏」不响应）
    const bottom = planDrop({
        tree: twoWindows(),
        window: 'A',
        pointer: [300, 795],
        threshold: THRESHOLD,
    });
    assert.equal(bottom.action, DROP_EDGE);
    assert.equal(bottom.detail.edge, 'bottom');
    assert.equal(bottom.detail.neighbor, 'B');

    // 真正「两个上下窗口之间」的那条横线也可以插入新行
    const rows = new LayoutTree({gap: 0, minSize: 100});
    rows.setSingleWindow('T');
    rows.layout(AREA);
    rows.splitWindow('T', 'D', {ratio: 0.5, orientation: 'v'});
    rows.layout(AREA);
    rows.splitWindow('D', 'R', {ratio: 0.5, orientation: 'h'});
    rows.layout(AREA);
    const between = planDrop({tree: rows, window: 'R', pointer: [300, 400], threshold: THRESHOLD});
    assert.equal(between.action, DROP_BETWEEN);
    assert.equal(between.detail.column, false);
});

test('格子边缘优先于交换：在 P 的左侧边缘松手是与 P 平铺而不是交换（需求 4）', () => {
    const layout = threeWindows();
    const plan = planDrop({tree: layout, window: 'X', pointer: [3, 300], threshold: THRESHOLD});
    assert.equal(plan.action, DROP_EDGE);
    assert.equal(plan.detail.edge, 'left');
    assert.equal(plan.detail.neighbor, 'P');
    // 插入出一条新分栏 → 三列等宽（1600 / 3 会有 1px 的取整误差）
    const cols = ['X', 'P', 'Z'].map(name => plan.tree.rectFor(name));
    assert.ok(cols.every(rect => rect.y === 0 && rect.height === 600), cols.map(r => r && r.y).join());
    assert.ok(Math.max(...cols.map(r => r.width)) - Math.min(...cols.map(r => r.width)) <= 1,
        `三列宽度：${cols.map(r => r.width).join('/')}`);
    assert.equal(cols[0].x, 0);
    assert.equal(cols[0].x + cols[0].width, cols[1].x);
    assert.equal(cols[1].x + cols[1].width, cols[2].x);
    assert.equal(cols[2].x + cols[2].width, WIDE.width);
    assertNoOverlap(plan.tree, WIDE);
});

test('拖到两个窗口中间：插到它们之间（需求 4）', () => {
    const layout = threeWindows();
    assert.deepEqual(layout.windows(), ['P', 'Z', 'X']);

    const plan = planDrop({
        tree: layout,
        window: 'P',
        pointer: [1200, 300], // Z 与 X 的分界线上
        threshold: THRESHOLD,
    });

    assert.equal(plan.action, DROP_BETWEEN);
    assert.deepEqual(plan.tree.windows(), ['Z', 'P', 'X']);
    assert.deepEqual(plan.tree.rectFor('P'), plan.previewRect);
    // P 紧贴在 X 的左边
    const p = plan.tree.rectFor('P');
    const x = plan.tree.rectFor('X');
    assert.equal(p.x + p.width, x.x);
    assertNoOverlap(plan.tree, WIDE);
});

test('拖到另一个窗口的格子上：交换两个窗口的位置（需求 4）', () => {
    const layout = twoWindows();
    // 指针落在 B 的格子里（远离分界线）
    const plan = planDrop({tree: layout, window: 'A', pointer: [300, 400], threshold: THRESHOLD});

    assert.equal(plan.action, DROP_SWAP);
    assert.equal(plan.detail.target, 'B');
    assert.deepEqual(plan.tree.windows(), ['A', 'B']);
    assert.deepEqual(plan.tree.rectFor('A'), {x: 0, y: 0, width: 600, height: 800});
    assert.deepEqual(plan.tree.rectFor('B'), {x: 600, y: 0, width: 600, height: 800});
    assert.deepEqual(plan.previewRect, plan.tree.rectFor('A'));
});

test('拖回自己原来的格子：不做任何改动', () => {
    const layout = twoWindows();
    const plan = planDrop({tree: layout, window: 'A', pointer: [900, 400], threshold: THRESHOLD});
    assert.equal(plan.action, DROP_NONE);
    assert.equal(plan.previewRect, null);
    assert.equal(plan.tree, layout);
});

test('没有其它窗口时松手就铺满屏幕（需求 1）', () => {
    const layout = new LayoutTree({gap: 0, minSize: 100});
    layout.setSingleWindow('A');
    layout.layout(AREA);

    const plan = planDrop({tree: layout, window: 'A', pointer: [10, 10], threshold: THRESHOLD});
    assert.equal(plan.action, DROP_FILL);
    assert.deepEqual(plan.previewRect, AREA);
    assert.deepEqual(plan.tree.rectFor('A'), AREA);
});

test('带间隔时插入到两个窗口之间不会互相重叠', () => {
    const layout = threeWindows({gap: 8});
    const plan = planDrop({
        tree: layout,
        window: 'P',
        pointer: [1200, 300],
        threshold: THRESHOLD,
    });

    assert.equal(plan.action, DROP_BETWEEN);
    assertNoOverlap(plan.tree, WIDE);
    const p = plan.tree.rectFor('P');
    const left = plan.tree.windows()
        .map(window => plan.tree.rectFor(window))
        .find(rect => rect.x + rect.width <= p.x);
    const right = plan.tree.windows()
        .map(window => plan.tree.rectFor(window))
        .find(rect => rect.x >= p.x + p.width);
    assert.equal(left.x + left.width + 8, p.x);
    assert.equal(p.x + p.width + 8, right.x);
});

test('布局内只有自己时保持原状（例如窗口本来就不在布局里）', () => {
    const layout = twoWindows();
    const plan = planDrop({tree: layout, window: 'GHOST', pointer: [900, 400], threshold: THRESHOLD});
    assert.equal(plan.action, DROP_NONE);
});

/*
 * 补充要求：一条分界线可能横贯屏幕、同时挨着好几个窗口，
 * 这时应该按指针沿着这条线的位置，插到它真正相邻的那两个窗口之间。
 */
function spanningTree() {
    // 左边是 A；右边从上到下是 C、D、B
    const layout = new LayoutTree({gap: 0, minSize: 100});
    layout.setSingleWindow('A');
    layout.layout(AREA);
    layout.splitWindow('A', 'D', {before: false, ratio: 0.5, orientation: 'h'});
    layout.layout(AREA);
    layout.splitWindow('D', 'C', {before: true, ratio: 0.5, orientation: 'v'});
    layout.layout(AREA);
    layout.splitWindow('D', 'B', {before: false, ratio: 0.5, orientation: 'v'});
    layout.layout(AREA);
    return layout;
}

test('贯穿屏幕的分界线：按指针位置解析出真正相邻的窗口', () => {
    const layout = spanningTree();
    assert.deepEqual(layout.rectFor('A'), {x: 0, y: 0, width: 600, height: 800});
    assert.deepEqual(layout.rectFor('C'), {x: 600, y: 0, width: 600, height: 400});
    assert.deepEqual(layout.rectFor('D'), {x: 600, y: 400, width: 600, height: 200});
    assert.deepEqual(layout.rectFor('B'), {x: 600, y: 600, width: 600, height: 200});

    const boundary = layout.boundaries().find(b => b.position === 600);
    assert.ok(boundary, '应该存在一条位于 x=600 的分界线');
    assert.equal(boundary.orientation, 'h');
    assert.equal(boundary.from, 0);
    assert.equal(boundary.to, 800);

    assert.equal(layout.leavesAtBoundary(boundary, 100).after.window, 'C');
    assert.equal(layout.leavesAtBoundary(boundary, 500).after.window, 'D');
    assert.equal(layout.leavesAtBoundary(boundary, 700).after.window, 'B');
    assert.equal(layout.leavesAtBoundary(boundary, 700).before.window, 'A');
});

test('贯穿屏幕的分界线：插到这条线两侧的两组窗口之间（与指针高度无关）', () => {
    const upper = planDrop({
        tree: spanningTree(),
        window: 'D',
        pointer: [600, 100],
        threshold: THRESHOLD,
    });
    const lower = planDrop({
        tree: spanningTree(),
        window: 'D',
        pointer: [600, 700],
        threshold: THRESHOLD,
    });

    assert.equal(upper.action, DROP_BETWEEN);
    assert.equal(lower.action, DROP_BETWEEN);
    // 两种高度得到同样的结果：D 成为一整列，插在左侧一列与右侧一列之间，三列等宽
    assert.deepEqual(upper.tree.rectFor('D'), {x: 400, y: 0, width: 400, height: 800});
    assert.deepEqual(lower.tree.rectFor('D'), upper.tree.rectFor('D'));
    assert.deepEqual(upper.tree.rectFor('A'), {x: 0, y: 0, width: 400, height: 800});
    assert.deepEqual(upper.tree.rectFor('C'), {x: 800, y: 0, width: 400, height: 400});
    assert.deepEqual(upper.tree.rectFor('B'), {x: 800, y: 400, width: 400, height: 400});
    assertNoOverlap(upper.tree, AREA);
    assertNoOverlap(lower.tree, AREA);
});

test('分界线两侧各是一整列时，指针偏向哪一侧就让哪一列让位', () => {
    // 指针落在右侧一列里、贴着分界线 → 右侧整列（C 与 B）一起缩到一半宽度
    const plan = planDrop({
        tree: spanningTree(),
        window: 'D',
        pointer: [605, 700],
        threshold: THRESHOLD,
    });

    assert.equal(plan.action, DROP_BETWEEN);
    assert.equal(plan.detail.side, 'after');
    // 同样是三列等宽（右侧那一列整体让位，插进来之后一起均分）
    assert.deepEqual(plan.tree.rectFor('A'), {x: 0, y: 0, width: 400, height: 800});
    assert.deepEqual(plan.tree.rectFor('D'), {x: 400, y: 0, width: 400, height: 800});
    assert.deepEqual(plan.tree.rectFor('C'), {x: 800, y: 0, width: 400, height: 400});
    assert.deepEqual(plan.tree.rectFor('B'), {x: 800, y: 400, width: 400, height: 400});
    assertNoOverlap(plan.tree, AREA);
});

/*
 * 需求 4 里的「分栏」：宽度相同、高度可以不同的竖向排列窗口。
 * 插入时切的是整块分栏区域，所以分栏里的每个窗口会一起让位，宽度依然保持一致。
 */
function twoColumns() {
    const layout = new LayoutTree({gap: 0, minSize: 100});
    layout.setSingleWindow('A1');
    layout.layout(AREA);
    layout.splitWindow('A1', 'B1', {before: false, ratio: 0.5, orientation: 'h'});
    layout.layout(AREA);
    layout.splitWindow('A1', 'A2', {before: false, ratio: 0.5, orientation: 'v'});
    layout.layout(AREA);
    layout.splitWindow('B1', 'B2', {before: false, ratio: 0.5, orientation: 'v'});
    layout.layout(AREA);
    return layout;
}

test('两个分栏之间插入 → 新窗口成为一整列，相邻分栏整体让位（需求 4）', () => {
    const layout = twoColumns();
    // 把左列里的 D 拖到左右两个分栏之间的竖线上
    layout.splitWindow('A2', 'D', {before: false, ratio: 0.5, orientation: 'v'});
    layout.layout(AREA);
    assert.deepEqual(layout.windows(), ['A1', 'A2', 'D', 'B1', 'B2']);

    const plan = planDrop({tree: layout, window: 'D', pointer: [600, 700], threshold: THRESHOLD});
    assert.equal(plan.action, DROP_BETWEEN);
    assert.equal(plan.detail.column, true);

    // D 占满整列高度；插入之后三列等宽，列内部的上下一分为二不受影响
    assert.deepEqual(plan.tree.rectFor('D'), {x: 400, y: 0, width: 400, height: 800});
    assert.deepEqual(plan.tree.rectFor('A1'), {x: 0, y: 0, width: 400, height: 400});
    assert.deepEqual(plan.tree.rectFor('A2'), {x: 0, y: 400, width: 400, height: 400});
    assert.deepEqual(plan.tree.rectFor('B1'), {x: 800, y: 0, width: 400, height: 400});
    assert.deepEqual(plan.tree.rectFor('B2'), {x: 800, y: 400, width: 400, height: 400});
    assertNoOverlap(plan.tree, AREA);
});

test('分栏内部两个上下排列的窗口中间插入 → 新窗口是同宽的一行（需求 4）', () => {
    const layout = twoColumns();
    // 把右列的 B1 拖到左列 A1 / A2 之间的横线上（指针落在 A2 的格子里、贴着它的上边缘）
    const plan = planDrop({tree: layout, window: 'B1', pointer: [300, 405], threshold: THRESHOLD});

    assert.equal(plan.action, DROP_BETWEEN);
    assert.equal(plan.detail.column, false); // 这是分栏内部的横线
    const a1 = plan.tree.rectFor('A1');
    const b1 = plan.tree.rectFor('B1');
    const a2 = plan.tree.rectFor('A2');
    assert.deepEqual(b1, {x: 0, y: 400, width: 600, height: 200});
    assert.equal(b1.width, a1.width);
    assert.equal(b1.width, a2.width);
    assert.equal(a1.height + b1.height + a2.height, AREA.height);
    assertNoOverlap(plan.tree, AREA);
});

test('结构约束：在多行分栏旁边插入 → 整列让位，行里不会多出列（需求 4）', () => {
    const layout = twoColumns(); // 左列 A1/A2，右列 B1/B2
    // 把右列里的 B1 拖到左列 A1 的左侧边缘
    const plan = planDrop({tree: layout, window: 'B1', pointer: [4, 200], threshold: THRESHOLD});

    assert.equal(plan.action, DROP_EDGE);
    assert.equal(plan.detail.edge, 'left');
    assert.equal(plan.detail.unit, 'column');
    // 新窗口是一整列；插入之后三列等宽
    assert.deepEqual(plan.tree.rectFor('B1'), {x: 0, y: 0, width: 400, height: 800});
    // 原来的那两列整体让位，列内部 A1、A2 依然同宽、上下排列
    assert.deepEqual(plan.tree.rectFor('A1'), {x: 400, y: 0, width: 400, height: 400});
    assert.deepEqual(plan.tree.rectFor('A2'), {x: 400, y: 400, width: 400, height: 400});
    assert.deepEqual(plan.tree.rectFor('B2'), {x: 800, y: 0, width: 400, height: 800});
    assertNoOverlap(plan.tree, AREA);
    assertTwoLevel(plan.tree);
});

test('指针偏向分界线某一侧时，窗口插到那一侧', () => {
    const layout = twoWindows();
    // B | A，把 A 拖到分界线上偏左（B 那一侧）→ 插到 B 的右边，回到原来的位置
    const onLeftSide = planDrop({tree: layout, window: 'A', pointer: [590, 400], threshold: THRESHOLD});
    assert.equal(onLeftSide.action, DROP_BETWEEN);
    assert.deepEqual(onLeftSide.tree.windows(), ['B', 'A']);
    assert.deepEqual(onLeftSide.tree.rectFor('B'), {x: 0, y: 0, width: 600, height: 800});

    // 三窗口场景下更能看出差别：P | Z | X，把 P 拖到 Z 与 X 的分界线上
    const three = threeWindows();
    const onRightSide = planDrop({
        tree: three,
        window: 'P',
        pointer: [1206, 300], // 偏右 → 切分 X
        threshold: THRESHOLD,
    });
    assert.equal(onRightSide.action, DROP_BETWEEN);
    assert.deepEqual(onRightSide.tree.windows(), ['Z', 'P', 'X']);
    const p = onRightSide.tree.rectFor('P');
    const x = onRightSide.tree.rectFor('X');
    assert.equal(p.x + p.width, x.x);
    assert.equal(x.x + x.width, 1600);
});

test('插入型落点给出「间隙」高亮：窗口之间与屏幕边缘都用细长条表示', () => {
    const layout = threeWindows();   // 两列：P | (Z / X)
    // 1) 两个窗口之间：竖线的间隙
    const between = planDrop({tree: layout, window: 'P', pointer: [1200, 300], threshold: THRESHOLD});
    assert.equal(between.action, DROP_BETWEEN);
    assert.ok(between.gapRect, '应有 gapRect');
    assert.equal(between.gapRect.width, GAP_PREVIEW_THICKNESS);
    assert.equal(between.gapRect.x + between.gapRect.width / 2, 1200);
    assert.equal(between.gapRect.y, 0);
    assert.equal(between.gapRect.height, 600);

    // 2) 贴着某个窗口的边插入（这条边正好是屏幕左边）→ 间隙落在屏幕边缘
    const edge = planDrop({tree: layout, window: 'X', pointer: [3, 300], threshold: THRESHOLD});
    assert.equal(edge.action, DROP_EDGE);
    assert.ok(edge.gapRect, '贴边插入也要有 gapRect');
    assert.equal(edge.gapRect.width, GAP_PREVIEW_THICKNESS);
    assert.equal(edge.gapRect.x + edge.gapRect.width / 2, 0);
    assert.equal(edge.gapRect.y, 0);
    assert.equal(edge.gapRect.height, 600);

    // 3) 交换位置不画间隙（仍然高亮整个目标格子）
    const swap = planDrop({tree: layout, window: 'P', pointer: [1000, 450], threshold: THRESHOLD});
    assert.equal(swap.action, DROP_SWAP);
    assert.equal(swap.gapRect, undefined);
});

test('屏幕左右竖边：指针在这条边的任何高度都插出一个新分栏', () => {
    const layout = threeWindows();   // P | Z | X，三列等宽、整屏高
    // 任意高度（含面板/停靠区之外那段、正好压在行分界线高度上）
    for (const y of [10, 290, 300, 310, 590, -200, 900]) {
        const left = planDrop({tree: layout, window: 'Z', pointer: [3, y], threshold: THRESHOLD});
        assert.equal(left.action, DROP_EDGE, `y=${y}`);
        assert.equal(left.detail.edge, 'left', `y=${y}`);
        assert.equal(left.detail.unit, 'column', `y=${y}`);
        assert.equal(left.detail.screenEdge, true, `y=${y}`);
        const z = left.tree.rectFor('Z');
        const p = left.tree.rectFor('P');
        assert.equal(z.x, 0, `y=${y}：新分栏在最左边`);
        assert.ok(Math.abs(z.width - p.width) <= 1, `y=${y}：分栏等宽`);
        assert.equal(left.gapRect.x + left.gapRect.width / 2, 0, `y=${y}：间隙落在屏幕左边缘`);
        assertNoOverlap(left.tree, WIDE);
    }

    const right = planDrop({tree: layout, window: 'Z', pointer: [WIDE.width - 3, 301], threshold: THRESHOLD});
    assert.equal(right.action, DROP_EDGE);
    assert.equal(right.detail.edge, 'right');
    assert.equal(right.detail.unit, 'column');
    const z = right.tree.rectFor('Z');
    assert.equal(z.x + z.width, WIDE.width);
    assert.equal(right.gapRect.x + right.gapRect.width / 2, WIDE.width);
});

test('屏幕竖边优先于行分界线：贴着左边缘就不会被判定成「插新行」', () => {
    const layout = new LayoutTree({gap: 0, minSize: 100});
    layout.setSingleWindow('L1');
    layout.layout(WIDE);
    layout.splitWindow('L1', 'L2', {ratio: 0.5, orientation: 'v'});  // 左列两行
    layout.layout(WIDE);
    layout.splitWindow('L2', 'R', {ratio: 0.5, orientation: 'h'});   // 右边再分一列
    layout.layout(WIDE);
    // 左列的行分界线在 y=300；贴着屏幕左边（x=3）时仍然是插新分栏
    const atEdge = planDrop({tree: layout, window: 'R', pointer: [3, 300], threshold: THRESHOLD});
    assert.equal(atEdge.action, DROP_EDGE);
    assert.equal(atEdge.detail.unit, 'column');
    assert.equal(atEdge.detail.screenEdge, true);
    const r = atEdge.tree.rectFor('R');
    assert.equal(r.x, 0);
    // 离开屏幕边缘（x=100）时，同一条行分界线仍然是「插新行」
    const awayFromEdge = planDrop({tree: layout, window: 'R', pointer: [100, 300], threshold: THRESHOLD});
    assert.equal(awayFromEdge.action, DROP_BETWEEN);
    assert.equal(awayFromEdge.detail.column, false);
});

test('拖到屏幕竖边时高亮整条边框（整个屏幕高度，而不只是某一行）', () => {
    const layout = new LayoutTree({gap: 0, minSize: 100});
    layout.setSingleWindow('L1');
    layout.layout(WIDE);
    layout.splitWindow('L1', 'L2', {ratio: 0.5, orientation: 'v'});   // 左列两行
    layout.layout(WIDE);
    layout.splitWindow('L2', 'R', {ratio: 0.5, orientation: 'h'});    // 右边再一列
    layout.layout(WIDE);

    const plan = planDrop({tree: layout, window: 'R', pointer: [3, 100], threshold: THRESHOLD});
    assert.equal(plan.action, DROP_EDGE);
    assert.equal(plan.detail.screenEdge, true);
    assert.equal(plan.gapRect.x + plan.gapRect.width / 2, 0);
    assert.equal(plan.gapRect.y, WIDE.y);
    assert.equal(plan.gapRect.height, WIDE.height);
});

test('屏幕横边：对着自己被拖出来那一栏 → 在本栏内平铺；对着别的分栏 → 移过去', () => {
    const layout = new LayoutTree({gap: 0, minSize: 100});
    layout.setSingleWindow('L1');
    layout.layout(WIDE);
    layout.splitWindow('L1', 'L2', {ratio: 0.5, orientation: 'v'});   // 左栏两行
    layout.layout(WIDE);
    layout.splitWindow('L2', 'R', {ratio: 0.5, orientation: 'h'});    // 右边一栏
    layout.layout(WIDE);

    // 1) 左栏下面那行拖到同一栏顶边 → 在本栏里移到顶部（插新行、行高均分），
    //    不会跑出这一栏，也不会插出一整栏
    const ownTop = planDrop({tree: layout, window: 'L2', pointer: [300, 5], threshold: THRESHOLD});
    assert.equal(ownTop.action, DROP_EDGE);
    assert.equal(ownTop.detail.unit, 'row');
    assert.equal(ownTop.detail.sameColumn, true);
    assert.equal(ownTop.detail.edge, 'top');
    const topOrder = ['L1', 'L2', 'R']
        .filter(w => ownTop.tree.findLeaf(w))
        .sort((a, b) => ownTop.tree.rectFor(a).y - ownTop.tree.rectFor(b).y ||
            ownTop.tree.rectFor(a).x - ownTop.tree.rectFor(b).x);
    assert.equal(topOrder[0], 'L2', `顺序=${topOrder.join('')}`);
    assert.equal(ownTop.tree.columnCount(), 2, '分栏数不变');
    assert.equal(ownTop.tree.rectFor('L2').height, ownTop.tree.rectFor('L1').height);

    // 2) 左栏上面那行拖到同一栏底边 → 移到本栏底部
    const ownBottom = planDrop({tree: layout, window: 'L1', pointer: [300, WIDE.height - 5], threshold: THRESHOLD});
    assert.equal(ownBottom.action, DROP_EDGE);
    assert.equal(ownBottom.detail.unit, 'row');
    assert.equal(ownBottom.detail.edge, 'bottom');
    assert.equal(ownBottom.tree.rectFor('L1').y > ownBottom.tree.rectFor('L2').y, true);

    // 3) 同一栏顶边、指针同时压在分栏竖线旁 → 仍然是本栏内插行（不是插新分栏）
    const nearDivider = planDrop({tree: layout, window: 'L2', pointer: [WIDE.width / 2 - 5, 5], threshold: THRESHOLD});
    assert.equal(nearDivider.action, DROP_EDGE);
    assert.equal(nearDivider.detail.unit, 'row');

    // 4) 右栏的窗口拖到左栏顶边 → 移到左栏（插新行）
    const toOtherColumn = planDrop({tree: layout, window: 'R', pointer: [300, 5], threshold: THRESHOLD});
    assert.equal(toOtherColumn.action, DROP_EDGE);
    assert.equal(toOtherColumn.detail.edge, 'top');
    assert.equal(toOtherColumn.detail.unit, 'row');

    // 5) 只有自己一个窗口的分栏拖到自己的横边 → 没有别的行可交换，保持原样
    const single = new LayoutTree({gap: 0, minSize: 100});
    single.setSingleWindow('S1');
    single.layout(WIDE);
    single.splitWindow('S1', 'S2', {ratio: 0.5, orientation: 'h'});
    single.layout(WIDE);
    assert.equal(planDrop({tree: single, window: 'S1', pointer: [200, 5], threshold: THRESHOLD}).action, DROP_NONE);
});

test('拖的是最外侧那一栏的窗口时，竖边平铺依然生效', () => {
    const layout = threeWindows();   // P | Z | X
    // P 已经是最左边那一栏：拖到左竖边仍然是一次「插新分栏」的落点
    const plan = planDrop({tree: layout, window: 'P', pointer: [3, 300], threshold: THRESHOLD});
    assert.equal(plan.action, DROP_EDGE);
    assert.equal(plan.detail.edge, 'left');
    assert.equal(plan.detail.screenEdge, true);
    assert.equal(plan.tree.rectFor('P').x, 0);
    assert.ok(plan.gapRect);

    const fromRight = planDrop({tree: layout, window: 'X', pointer: [WIDE.width - 3, 300], threshold: THRESHOLD});
    assert.equal(fromRight.action, DROP_EDGE);
    assert.equal(fromRight.detail.edge, 'right');
    const x = fromRight.tree.rectFor('X');
    assert.equal(x.x + x.width, WIDE.width);
});

test('两行之间（分界线）仍然可以插入新行', () => {
    const layout = new LayoutTree({gap: 0, minSize: 100});
    layout.setSingleWindow('L1');
    layout.layout(WIDE);
    layout.splitWindow('L1', 'L2', {ratio: 0.5, orientation: 'v'});
    layout.layout(WIDE);
    layout.splitWindow('L2', 'R', {ratio: 0.5, orientation: 'h'});
    layout.layout(WIDE);

    // 指针压在左列的行分界线上、离开屏幕边缘 → 在左列插入新行
    const plan = planDrop({tree: layout, window: 'R', pointer: [300, 300], threshold: THRESHOLD});
    assert.equal(plan.action, DROP_BETWEEN);
    assert.equal(plan.detail.column, false);
    assert.ok(plan.gapRect);
    assert.equal(plan.gapRect.height, 6);   // 横向细长条
});

test('间隙高亮的粗细跟随 gapThickness（与设置项 preview-border-width 共用）', () => {
    const layout = threeWindows();
    const between = planDrop({
        tree: layout, window: 'P', pointer: [1200, 300], threshold: THRESHOLD, gapThickness: 10,
    });
    assert.equal(between.action, DROP_BETWEEN);
    assert.equal(between.gapRect.width, 10);

    const edge = planDrop({
        tree: layout, window: 'X', pointer: [3, 300], threshold: THRESHOLD, gapThickness: 14,
    });
    assert.equal(edge.action, DROP_EDGE);
    assert.equal(edge.gapRect.width, 14);
});
