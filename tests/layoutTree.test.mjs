// 运行方式（在扩展根目录）：node --test
import test from 'node:test';
import assert from 'node:assert/strict';

import {LayoutTree, firstLeaf, lastLeaf, subtreeContains} from '../lib/layoutTree.js';

const AREA = {x: 0, y: 0, width: 1200, height: 800};

function tree(options = {}) {
    return new LayoutTree({gap: 0, minSize: 100, ...options});
}

test('单个窗口铺满整个工作区（需求 1）', () => {
    const layout = tree();
    layout.setSingleWindow('A');
    layout.layout(AREA);
    assert.deepEqual(layout.rectFor('A'), AREA);
});

test('左右并排平分，两个矩形正好拼满工作区', () => {
    const layout = tree();
    layout.setSingleWindow('A');
    layout.layout(AREA);
    layout.splitWindow('A', 'B', {before: true, ratio: 0.5});
    layout.layout(AREA);

    assert.deepEqual(layout.describe(), {orientation: 'h', ratio: 0.5, first: 'B', second: 'A'});
    assert.deepEqual(layout.rectFor('B'), {x: 0, y: 0, width: 600, height: 800});
    assert.deepEqual(layout.rectFor('A'), {x: 600, y: 0, width: 600, height: 800});
});

test('按长边切分：竖长条上下切，横长条左右切', () => {
    const layout = tree();
    layout.setSingleWindow('A');
    layout.layout(AREA);
    layout.splitWindow('A', 'B', {ratio: 0.5}); // A | B，两块都是 600x800 的竖长条
    layout.layout(AREA);
    assert.deepEqual(layout.describe(), {orientation: 'h', ratio: 0.5, first: 'A', second: 'B'});

    layout.splitWindow('A', 'C', {ratio: 0.5}); // 切 A 时应改为上下切
    layout.layout(AREA);
    assert.equal(layout.describe().first.orientation, 'v');
    assert.deepEqual(layout.rectFor('A'), {x: 0, y: 0, width: 600, height: 400});
    assert.deepEqual(layout.rectFor('C'), {x: 0, y: 400, width: 600, height: 400});
});

test('移除窗口后兄弟子树吸收全部空间（最小化后其余窗口自动铺满）', () => {
    const layout = tree();
    layout.setSingleWindow('A');
    layout.splitWindow('A', 'B');
    layout.layout(AREA);
    layout.splitWindow('B', 'C');
    layout.layout(AREA);

    assert.equal(layout.size(), 3);
    assert.ok(layout.removeWindow('C'));
    layout.layout(AREA);
    assert.deepEqual(layout.windows().sort(), ['A', 'B']);
    // A 保持不变，B 吸收了 C 空出来的空间（右半边整块）
    assert.deepEqual(layout.rectFor('A'), {x: 0, y: 0, width: 600, height: 800});
    assert.deepEqual(layout.rectFor('B'), {x: 600, y: 0, width: 600, height: 800});
});

test('移除最后一个窗口后树为空', () => {
    const layout = tree();
    layout.setSingleWindow('A');
    assert.ok(layout.removeWindow('A'));
    assert.equal(layout.isEmpty, true);
    assert.equal(layout.removeWindow('A'), false);
});

test('replaceWindow 让新窗口接管原窗口的格子（需求 2）', () => {
    const layout = tree();
    layout.setSingleWindow('A');
    layout.splitWindow('A', 'B');
    layout.layout(AREA);
    const before = layout.rectFor('A');

    assert.ok(layout.replaceWindow('A', 'NEW'));
    layout.layout(AREA);
    assert.deepEqual(layout.rectFor('NEW'), before);
    assert.equal(layout.findLeaf('A'), null);
});

test('swapWindows 交换两个窗口的位置（需求 4）', () => {
    const layout = tree();
    layout.setSingleWindow('A');
    layout.splitWindow('A', 'B');
    layout.layout(AREA);
    layout.splitWindow('B', 'C');
    layout.layout(AREA);

    const rectA = layout.rectFor('A');
    const rectC = layout.rectFor('C');
    assert.ok(layout.swapWindows('A', 'C'));
    layout.layout(AREA);
    assert.deepEqual(layout.rectFor('A'), rectC);
    assert.deepEqual(layout.rectFor('C'), rectA);
});

test('columnRegion 找出窗口所在的分栏（布局的第一层）', () => {
    const layout = tree();
    layout.setSingleWindow('A1');
    layout.layout(AREA);
    layout.splitWindow('A1', 'B1', {before: false, ratio: 0.5, orientation: 'h'});
    layout.layout(AREA);
    layout.splitWindow('A1', 'A2', {before: false, ratio: 0.5, orientation: 'v'});
    layout.layout(AREA);

    const a1 = layout.findLeaf('A1');
    const a2 = layout.findLeaf('A2');
    const b1 = layout.findLeaf('B1');
    const column = layout.columnRegion(a1);
    // 同一列里的窗口得到同一个分栏，分栏的范围就是整列
    assert.equal(layout.columnRegion(a2), column);
    assert.deepEqual(layout.nodeRect(column), {x: 0, y: 0, width: 600, height: 800});
    // 单独占一列的窗口返回它自己
    assert.equal(layout.columnRegion(b1), b1);
});

test('splitNode 对分栏里的窗口做横向切分时，切成整列（行里不能多出列）', () => {
    const layout = tree();
    layout.setSingleWindow('A1');
    layout.layout(AREA);
    layout.splitWindow('A1', 'B1', {before: false, ratio: 0.5, orientation: 'h'});
    layout.layout(AREA);
    layout.splitWindow('A1', 'A2', {before: false, ratio: 0.5, orientation: 'v'});
    layout.layout(AREA);

    // 对左列下半行的 A2 做横向切分 → 实际切的是整个左列
    layout.splitLeafNode(layout.findLeaf('A2'), 'D', {before: false, ratio: 0.5, orientation: 'h'});
    layout.layout(AREA);
    assert.deepEqual(layout.rectFor('D'), {x: 300, y: 0, width: 300, height: 800});
    assert.deepEqual(layout.rectFor('A1'), {x: 0, y: 0, width: 300, height: 400});
    assert.deepEqual(layout.rectFor('A2'), {x: 0, y: 400, width: 300, height: 400});
    assert.deepEqual(layout.rectFor('B1'), {x: 600, y: 0, width: 600, height: 800});
});

test('setEdge 拖动窗口边缘时其余窗口联动缩放（需求 5）', () => {
    const layout = tree();
    layout.setSingleWindow('A');
    layout.splitWindow('A', 'B', {before: true, ratio: 0.5});
    layout.layout(AREA);
    layout.splitWindow('A', 'C', {ratio: 0.5}); // B | (A / C)
    layout.layout(AREA);
    assert.deepEqual(layout.rectFor('A'), {x: 600, y: 0, width: 600, height: 400});
    assert.deepEqual(layout.rectFor('C'), {x: 600, y: 400, width: 600, height: 400});

    // 拖动 B 的右边缘到 x=300：B 变窄，右侧整棵子树（A、C）一起变宽
    assert.ok(layout.setEdge('B', 'e', 300));
    layout.layout(AREA);
    assert.deepEqual(layout.rectFor('B'), {x: 0, y: 0, width: 300, height: 800});
    assert.deepEqual(layout.rectFor('A'), {x: 300, y: 0, width: 900, height: 400});
    assert.deepEqual(layout.rectFor('C'), {x: 300, y: 400, width: 900, height: 400});
});

test('setEdgeExact 只动紧挨着这条边的两侧，嵌套子树里的其它列不动（左中右）', () => {
    const layout = tree();
    layout.setSingleWindow('A');
    layout.layout(AREA);
    // B | A，然后 (B | C) | A —— 三个等宽的分栏
    layout.splitWindow('A', 'B', {before: true, ratio: 2 / 3, orientation: 'h'});
    layout.layout(AREA);
    layout.splitWindow('B', 'C', {ratio: 0.5, orientation: 'h'});
    layout.layout(AREA);
    assert.deepEqual(layout.rectFor('B'), {x: 0, y: 0, width: 400, height: 800});
    assert.deepEqual(layout.rectFor('C'), {x: 400, y: 0, width: 400, height: 800});
    assert.deepEqual(layout.rectFor('A'), {x: 800, y: 0, width: 400, height: 800});

    // 拖动中间那列（C）的右边框到 x=900：只有 C 和紧挨着的 A 变，最左边的 B 一点不动
    assert.ok(layout.setEdgeExact('C', 'e', 900));
    layout.layout(AREA);
    assert.deepEqual(layout.rectFor('B'), {x: 0, y: 0, width: 400, height: 800});
    assert.deepEqual(layout.rectFor('C'), {x: 400, y: 0, width: 500, height: 800});
    assert.deepEqual(layout.rectFor('A'), {x: 900, y: 0, width: 300, height: 800});

    // 反过来拖动同一个边框：B 依旧不动
    assert.ok(layout.setEdgeExact('C', 'e', 700));
    layout.layout(AREA);
    assert.equal(layout.rectFor('B').width, 400);
    assert.equal(layout.rectFor('C').width, 300);
    assert.equal(layout.rectFor('A').width, 500);
});

test('setEdgeExact 上下排列时只动相邻的两行，最下面那行不动（上中下）', () => {
    const layout = tree();
    layout.setSingleWindow('A');
    layout.layout(AREA);
    // A / B，然后 A / (B / C)
    layout.splitWindow('A', 'B', {ratio: 0.5, orientation: 'v'});
    layout.layout(AREA);
    layout.splitWindow('B', 'C', {ratio: 0.5, orientation: 'v'});
    layout.layout(AREA);
    assert.deepEqual(layout.rectFor('A'), {x: 0, y: 0, width: 1200, height: 400});
    assert.deepEqual(layout.rectFor('B'), {x: 0, y: 400, width: 1200, height: 200});
    assert.deepEqual(layout.rectFor('C'), {x: 0, y: 600, width: 1200, height: 200});

    // 拖动中间窗口的上边框到 y=300：A、B 变，最下面的 C 一动不动
    assert.ok(layout.setEdgeExact('B', 'n', 300));
    layout.layout(AREA);
    assert.deepEqual(layout.rectFor('A'), {x: 0, y: 0, width: 1200, height: 300});
    assert.deepEqual(layout.rectFor('B'), {x: 0, y: 300, width: 1200, height: 300});
    assert.deepEqual(layout.rectFor('C'), {x: 0, y: 600, width: 1200, height: 200});
});

test('resizeUnits 只包含这条边两侧相邻的两块（拖动时只允许它们变）', () => {
    const layout = tree();
    layout.setSingleWindow('A');
    layout.layout(AREA);
    layout.splitWindow('A', 'B', {before: true, ratio: 2 / 3, orientation: 'h'});
    layout.layout(AREA);
    layout.splitWindow('B', 'C', {ratio: 0.5, orientation: 'h'});   // (B | C) | A
    layout.layout(AREA);
    assert.deepEqual(layout.resizeUnits('C', 'e')?.windows.sort(), ['A', 'C']);
    assert.deepEqual(layout.resizeUnits('B', 'e')?.windows.sort(), ['B', 'C']);
    assert.equal(layout.resizeUnits('A', 'e'), null);   // 贴着屏幕右边，没有分界线

    const rows = tree();
    rows.setSingleWindow('A');
    rows.layout(AREA);
    rows.splitWindow('A', 'B', {ratio: 0.5, orientation: 'v'});
    rows.layout(AREA);
    rows.splitWindow('B', 'C', {ratio: 0.5, orientation: 'v'});     // A / (B / C)
    rows.layout(AREA);
    assert.deepEqual(rows.resizeUnits('B', 'n')?.windows.sort(), ['A', 'B']);
    assert.deepEqual(rows.resizeUnits('B', 's')?.windows.sort(), ['B', 'C']);
});

test('snapshotRatios / restoreRatios 能把一次拖动回滚', () => {
    const layout = tree();
    layout.setSingleWindow('A');
    layout.layout(AREA);
    layout.splitWindow('A', 'B', {before: true, ratio: 0.5, orientation: 'h'});
    layout.layout(AREA);
    const before = new Map(layout.windows().map(w => [w, layout.rectFor(w)]));
    const snapshot = layout.snapshotRatios();
    layout.setEdgeExact('B', 'e', 300);
    layout.layout(AREA);
    assert.notDeepEqual(layout.rectFor('B'), before.get('B'));
    assert.ok(layout.restoreRatios(snapshot));
    layout.layout(AREA);
    for (const [window, rect] of before)
        assert.deepEqual(layout.rectFor(window), rect);
});

test('setEdgeExact 停在两侧分栏的最小尺寸上（其它窗口仍然不动）', () => {
    const layout = tree({minSize: 150});
    layout.setSingleWindow('A');
    layout.layout(AREA);
    layout.splitWindow('A', 'B', {before: true, ratio: 2 / 3, orientation: 'h'});
    layout.layout(AREA);
    layout.splitWindow('B', 'C', {ratio: 0.5, orientation: 'h'});
    layout.layout(AREA);
    assert.deepEqual(layout.rectFor('B'), {x: 0, y: 0, width: 400, height: 800});
    assert.deepEqual(layout.rectFor('C'), {x: 400, y: 0, width: 400, height: 800});
    assert.deepEqual(layout.rectFor('A'), {x: 800, y: 0, width: 400, height: 800});

    // 一直往右拖：C 不能把 A 压到小于 150，所以边界停在 1050
    layout.setEdgeExact('C', 'e', 1200);
    layout.layout(AREA);
    assert.deepEqual(layout.rectFor('B'), {x: 0, y: 0, width: 400, height: 800});
    assert.deepEqual(layout.rectFor('C'), {x: 400, y: 0, width: 650, height: 800});
    assert.deepEqual(layout.rectFor('A'), {x: 1050, y: 0, width: 150, height: 800});

    // 一直往左拖：C 本身不能小于 150，边界停在 550，A 与 B 各自保持对应的宽度
    layout.setEdgeExact('C', 'e', 0);
    layout.layout(AREA);
    assert.equal(layout.rectFor('B').width, 400);
    assert.deepEqual(layout.rectFor('C'), {x: 400, y: 0, width: 150, height: 800});
    assert.deepEqual(layout.rectFor('A'), {x: 550, y: 0, width: 650, height: 800});
});

/* ---------------------------------------------------------------------------
 * 需求 5 的严格语义：拖一条分界线时
 *   · 只有紧挨着这条边的两块（一列 / 一行）改变尺寸；
 *   · 其它窗口的矩形一点不变；
 *   · 相邻两块在拖动方向上的尺寸之和不变（总尺寸不变，所以挤不到别人）。
 * 这里遍历一棵树里所有的分界线，两种拖动距离都试一遍 —— 覆盖各种嵌套形状。
 * ------------------------------------------------------------------------- */

function assertTiles(area, layout, label) {
    const rects = layout.leaves().map(leaf => layout.rectFor(leaf.window));
    let sum = 0;
    for (let i = 0; i < rects.length; i++) {
        const rect = rects[i];
        assert.ok(rect.x >= area.x && rect.y >= area.y &&
            rect.x + rect.width <= area.x + area.width &&
            rect.y + rect.height <= area.y + area.height,
            `${label}：窗口出界 ${JSON.stringify(rect)}`);
        sum += rect.width * rect.height;
        for (let j = i + 1; j < rects.length; j++) {
            const other = rects[j];
            const dx = Math.min(rect.x + rect.width, other.x + other.width) - Math.max(rect.x, other.x);
            const dy = Math.min(rect.y + rect.height, other.y + other.height) - Math.max(rect.y, other.y);
            assert.ok(dx <= 0 || dy <= 0,
                `${label}：窗口重叠 ${JSON.stringify(rect)} / ${JSON.stringify(other)}`);
        }
    }
    assert.equal(sum, area.width * area.height, `${label}：没有铺满工作区`);
}

function checkExactResize(build, label) {
    const layout = build();
    layout.layout(AREA);
    const boundaries = layout.boundaries();
    assert.ok(boundaries.length > 0, `${label}：没有可拖的分界线`);

    for (const delta of [24, 400]) {
        for (let index = 0; index < boundaries.length; index++) {
            // 每一轮都从同一棵树重新开始，互不影响
            const current = build();
            current.layout(AREA);
            const boundary = current.boundaries()[index];
            const horizontal = boundary.orientation === 'h';
            const unitOf = leaf => (horizontal ? current.columnRegion(leaf) : leaf);
            const beforeUnit = unitOf(boundary.before);
            const afterUnit = unitOf(boundary.after);
            const beforeRect = current.nodeRect(beforeUnit);
            const afterRect = current.nodeRect(afterUnit);
            const snapshot = new Map(current.windows().map(window => [window, current.rectFor(window)]));
            const sumOf = (a, b) => (horizontal ? a.width + b.width : a.height + b.height);
            const totalBefore = sumOf(beforeRect, afterRect);

            current.setEdgeExact(boundary.before.window, horizontal ? 'e' : 's',
                boundary.position + delta);
            current.layout(AREA);

            for (const leaf of current.leaves()) {
                if (subtreeContains(beforeUnit, leaf) || subtreeContains(afterUnit, leaf))
                    continue;
                assert.deepEqual(current.rectFor(leaf.window), snapshot.get(leaf.window),
                    `${label}（Δ=${delta}）：不挨着这条边的 ${leaf.window} 被改动了`);
            }
            // 相邻两块的尺寸之和不变 —— 一旦变了，就说明多出来的尺寸只能从别人身上拿
            assert.equal(sumOf(current.nodeRect(beforeUnit), current.nodeRect(afterUnit)), totalBefore,
                `${label}（Δ=${delta}）：相邻两块的尺寸之和变了`);
            assertTiles(AREA, current, `${label}（Δ=${delta}）`);
        }
    }
}

const shapes = {
    '左中右 ((A|B)|C)': () => {
        const layout = tree();
        layout.setSingleWindow('A');
        layout.layout(AREA);
        layout.splitWindow('A', 'B', {before: true, ratio: 2 / 3, orientation: 'h'});
        layout.layout(AREA);
        layout.splitWindow('B', 'C', {ratio: 0.5, orientation: 'h'});
        layout.layout(AREA);
        return layout;
    },
    '左中右 (A|(B|C))': () => {
        const layout = tree();
        layout.setSingleWindow('A');
        layout.layout(AREA);
        layout.splitWindow('A', 'B', {before: true, ratio: 0.5, orientation: 'h'});
        layout.layout(AREA);
        layout.splitWindow('A', 'C', {ratio: 0.5, orientation: 'h'});
        layout.layout(AREA);
        return layout;
    },
    '四栏 ((A|B)|(C|D))': () => {
        const layout = tree();
        layout.setSingleWindow('A');
        layout.layout(AREA);
        layout.splitWindow('A', 'B', {before: true, ratio: 2 / 3, orientation: 'h'});
        layout.layout(AREA);
        layout.splitWindow('B', 'C', {ratio: 0.5, orientation: 'h'});
        layout.layout(AREA);
        layout.splitWindow('A', 'D', {before: true, ratio: 0.5, orientation: 'h'});
        layout.layout(AREA);
        return layout;
    },
    '上中下 (A/(B/C))': () => {
        const layout = tree();
        layout.setSingleWindow('A');
        layout.layout(AREA);
        layout.splitWindow('A', 'B', {ratio: 0.5, orientation: 'v'});
        layout.layout(AREA);
        layout.splitWindow('B', 'C', {ratio: 0.5, orientation: 'v'});
        layout.layout(AREA);
        return layout;
    },
    '四行 ((A/B)/(C/D))': () => {
        const layout = tree();
        layout.setSingleWindow('A');
        layout.layout(AREA);
        layout.splitWindow('A', 'B', {ratio: 0.5, orientation: 'v'});
        layout.layout(AREA);
        layout.splitWindow('B', 'C', {ratio: 0.5, orientation: 'v'});
        layout.layout(AREA);
        layout.splitWindow('A', 'D', {ratio: 0.5, orientation: 'v'});
        layout.layout(AREA);
        return layout;
    },
    '列里有行 + 一栏': () => {
        const layout = tree();
        layout.setSingleWindow('A');
        layout.layout(AREA);
        layout.splitWindow('A', 'B', {ratio: 0.5, orientation: 'v'});
        layout.layout(AREA);
        layout.splitWindow('B', 'C', {ratio: 0.5, orientation: 'h'});
        layout.layout(AREA);
        return layout;
    },
    '两列各有两行': () => {
        const layout = tree();
        layout.setSingleWindow('A');
        layout.layout(AREA);
        layout.splitWindow('A', 'B', {ratio: 0.5, orientation: 'v'});
        layout.layout(AREA);
        layout.splitWindow('B', 'C', {ratio: 0.5, orientation: 'h'});
        layout.layout(AREA);
        layout.splitWindow('A', 'D', {ratio: 0.5, orientation: 'h'});
        layout.layout(AREA);
        return layout;
    },
};

for (const [label, build] of Object.entries(shapes)) {
    test(`setEdgeExact 只动相邻两块、总尺寸不变：${label}`, () => {
        checkExactResize(build, label);
    });
}

test('setEdge 拖动右侧窗口的左边缘时改写祖先比例', () => {
    const wide = {x: 0, y: 0, width: 1600, height: 600};
    const layout = tree();
    layout.setSingleWindow('A');
    layout.layout(wide);
    layout.splitWindow('A', 'B', {before: true, ratio: 0.5, orientation: 'h'}); // B | A
    layout.layout(wide);
    layout.splitWindow('B', 'C', {ratio: 0.5, orientation: 'h'});               // (B | C) | A
    layout.layout(wide);
    assert.deepEqual(layout.rectFor('B'), {x: 0, y: 0, width: 400, height: 600});
    assert.deepEqual(layout.rectFor('C'), {x: 400, y: 0, width: 400, height: 600});
    assert.deepEqual(layout.rectFor('A'), {x: 800, y: 0, width: 800, height: 600});

    // 把 A 的左边缘拖到 x=1200：A 变窄，左侧子树的窗口一起变宽
    assert.ok(layout.setEdge('A', 'w', 1200));
    layout.layout(wide);
    assert.deepEqual(layout.rectFor('A'), {x: 1200, y: 0, width: 400, height: 600});
    assert.equal(layout.rectFor('B').width, 600);
    assert.equal(layout.rectFor('C').width, 600);
});

test('可以强制切分方向（例如把竖长条左右切开）', () => {
    const tall = {x: 0, y: 0, width: 600, height: 1200};
    const layout = tree();
    layout.setSingleWindow('A');
    layout.layout(tall);

    // 不指定方向时按长边切分 → 上下切
    layout.splitWindow('A', 'B', {ratio: 0.5});
    layout.layout(tall);
    assert.deepEqual(layout.rectFor('B'), {x: 0, y: 600, width: 600, height: 600});
    assert.ok(layout.removeWindow('B'));

    // 强制 'h' → 左右切
    layout.splitWindow('A', 'B', {ratio: 0.5, orientation: 'h'});
    layout.layout(tall);
    assert.deepEqual(layout.rectFor('A'), {x: 0, y: 0, width: 300, height: 1200});
    assert.deepEqual(layout.rectFor('B'), {x: 300, y: 0, width: 300, height: 1200});
});

test('setEdge 在找不到对应方向的祖先时返回 false（例如已贴着屏幕边缘）', () => {
    const layout = tree();
    layout.setSingleWindow('A');
    layout.layout(AREA);
    layout.splitWindow('A', 'B', {before: true, ratio: 0.5});
    layout.layout(AREA);
    assert.equal(layout.setEdge('B', 'w', 0), false);
});

test('setEdge 遵守最小窗口尺寸，不会把窗口压扁', () => {
    const layout = tree({minSize: 200});
    layout.setSingleWindow('A');
    layout.layout(AREA);
    layout.splitWindow('A', 'B', {before: true, ratio: 0.5});
    layout.layout(AREA);

    assert.ok(layout.setEdge('B', 'e', 10));
    layout.layout(AREA);
    assert.equal(layout.rectFor('B').width, 200);
    assert.equal(layout.rectFor('A').width, 1000);
});

test('带间隔 gap 时矩形互不重叠且都落在工作区内', () => {
    const layout = tree({gap: 8});
    layout.setSingleWindow('A');
    layout.layout(AREA);
    layout.splitWindow('A', 'B', {before: true, ratio: 0.5});
    layout.layout(AREA);

    const a = layout.rectFor('A');
    const b = layout.rectFor('B');
    assert.equal(b.x + b.width + 8, a.x);
    assert.equal(a.x + a.width, AREA.width);
    assert.equal(a.height, AREA.height);
});

test('boundaries 报告相邻窗口之间的分界线', () => {
    const layout = tree();
    layout.setSingleWindow('A');
    layout.layout(AREA);
    layout.splitWindow('A', 'B', {before: true, ratio: 0.5});
    layout.layout(AREA);

    const boundaries = layout.boundaries();
    assert.equal(boundaries.length, 1);
    assert.equal(boundaries[0].orientation, 'h');
    assert.equal(boundaries[0].position, 600);
    assert.equal(boundaries[0].before.window, 'B');
    assert.equal(boundaries[0].after.window, 'A');
    assert.equal(boundaries[0].from, 0);
    assert.equal(boundaries[0].to, 800);
});

test('clone 生成的副本与原树互不影响', () => {
    const layout = tree();
    layout.setSingleWindow('A');
    layout.splitWindow('A', 'B');
    layout.layout(AREA);

    const copy = layout.clone();
    copy.removeWindow('B');
    copy.layout(AREA);
    layout.layout(AREA);

    assert.equal(layout.size(), 2);
    assert.equal(copy.size(), 1);
    assert.equal(layout.rectFor('A').width, 600);
    assert.equal(copy.rectFor('A').width, 1200);
});

test('firstLeaf / lastLeaf 取子树两端的窗口', () => {
    const layout = tree();
    layout.setSingleWindow('A');
    layout.splitWindow('A', 'B', {before: true, ratio: 0.5});
    layout.layout(AREA);
    layout.splitWindow('A', 'C', {ratio: 0.5}); // B | (A / C)
    layout.layout(AREA);

    assert.equal(firstLeaf(layout.root).window, 'B');
    assert.equal(lastLeaf(layout.root).window, 'C');
    assert.equal(lastLeaf(layout.root.first).window, 'B');
});

test('结构变化后缓存几何失效，必须在 layout() 之后读取', () => {
    const layout = tree();
    layout.setSingleWindow('A');
    layout.layout(AREA);
    assert.ok(layout.rectFor('A'));
    layout.splitWindow('A', 'B');
    assert.equal(layout.rectFor('A'), null);
});
test('splitNode 切开一整组窗口时，组里的窗口一起让位（分栏不会被拆散）', () => {
    const layout = tree();
    layout.setSingleWindow('A1');
    layout.layout(AREA);
    layout.splitWindow('A1', 'A2', {before: false, ratio: 0.5, orientation: 'v'});
    layout.layout(AREA);
    // 现在整棵树就是一个「分栏」：A1 在上、A2 在下，宽度相同
    const column = layout.root;
    assert.equal(column.kind, 'split');
    assert.deepEqual(layout.rectFor('A1'), {x: 0, y: 0, width: 1200, height: 400});
    assert.deepEqual(layout.rectFor('A2'), {x: 0, y: 400, width: 1200, height: 400});

    // 把这一整组切一半塞进新窗口：分栏里的两个窗口各让出一半宽度，上下关系不变
    layout.splitNode(column, 'D', {before: false, ratio: 0.5, orientation: 'h'});
    layout.layout(AREA);
    assert.deepEqual(layout.rectFor('D'), {x: 600, y: 0, width: 600, height: 800});
    assert.deepEqual(layout.rectFor('A1'), {x: 0, y: 0, width: 600, height: 400});
    assert.deepEqual(layout.rectFor('A2'), {x: 0, y: 400, width: 600, height: 400});
});


test('equalizeRows 把一栏里的行高均分（其它分栏不动，间隔也扣掉）', () => {
    const layout = tree();
    layout.setSingleWindow('A');
    layout.layout(AREA);
    layout.splitWindow('A', 'B', {ratio: 0.7, orientation: 'v'});
    layout.layout(AREA);
    layout.splitWindow('B', 'C', {ratio: 0.6, orientation: 'v'});
    layout.layout(AREA);
    assert.ok(layout.rectFor('A').height > layout.rectFor('C').height);

    layout.equalizeRows(layout.columnRegion(layout.findLeaf('A')));
    layout.layout(AREA);
    const heights = ['A', 'B', 'C'].map(w => layout.rectFor(w).height);
    assert.ok(Math.max(...heights) - Math.min(...heights) <= 1, `高度=${heights.join('/')}`);
    assert.equal(heights.reduce((a, b) => a + b, 0), AREA.height);

    // 另一栏的行高不受影响
    const side = tree();
    side.setSingleWindow('A');
    side.layout(AREA);
    side.splitWindow('A', 'B', {ratio: 0.75, orientation: 'v'});   // 左栏：A 0.75 / B 0.25
    side.layout(AREA);
    side.splitWindow('B', 'C', {ratio: 0.5, orientation: 'h'});    // B 的右边分出 C 一栏
    side.layout(AREA);
    side.splitWindow('C', 'D', {ratio: 0.6, orientation: 'v'});    // 右栏：C / D
    side.layout(AREA);
    const rightHeights = ['C', 'D'].map(w => side.rectFor(w).height);
    side.equalizeRows(side.columnRegion(side.findLeaf('A')));
    side.layout(AREA);
    assert.deepEqual(['C', 'D'].map(w => side.rectFor(w).height), rightHeights);
    assert.equal(side.rectFor('A').height, side.rectFor('B').height);
});

test('equalizeRows 带间隔时每一行的实际高度仍然相等', () => {
    const layout = tree({gap: 10});
    layout.setSingleWindow('A');
    layout.layout(AREA);
    layout.splitWindow('A', 'B', {ratio: 0.6, orientation: 'v'});
    layout.layout(AREA);
    layout.splitWindow('B', 'C', {ratio: 0.5, orientation: 'v'});
    layout.layout(AREA);
    layout.equalizeRows(layout.columnRegion(layout.findLeaf('A')));
    layout.layout(AREA);
    const heights = ['A', 'B', 'C'].map(w => layout.rectFor(w).height);
    assert.ok(Math.max(...heights) - Math.min(...heights) <= 1, `高度=${heights.join('/')}`);
    // 三行 + 两条间隔正好铺满
    assert.equal(heights.reduce((a, b) => a + b, 0) + 20, AREA.height);
});
