// SPDX-License-Identifier: MIT
/*
 * layoutTree.js —— 平铺布局的核心数据结构：二叉空间分割树（BSP tree）。
 *
 * 设计要点
 * --------
 * · 每个叶子（leaf）对应一个窗口，每个内部节点（split）把一个矩形切成两块。
 * · split.ratio 表示「总长度中分给第一个孩子的比例」（0~1，含间隔 gap），
 *   这样 ratio=0.5 就是严格平分，读写都很直观。
 * · 拖动窗口边缘调整大小时，只需要改写「对应方向最近的那个祖先 split」的比例，
 *   同一子树里的其它窗口会自动跟着变大变小 —— 这就是需求 5 的联动。
 *
 * 本文件不依赖任何 GNOME / GI API，纯 JS，因此可以直接用 node 做单元测试。
 */

let nextNodeId = 1;

function makeLeaf(window, parent = null) {
    return {id: nextNodeId++, kind: 'leaf', window, parent};
}

function makeSplit(orientation, ratio, first, second, parent = null) {
    const node = {
        id: nextNodeId++,
        kind: 'split',
        orientation, // 'h' = 左右并排，'v' = 上下堆叠
        ratio,
        first,
        second,
        parent,
    };
    first.parent = node;
    second.parent = node;
    return node;
}

function clamp(value, lo, hi) {
    return Math.max(lo, Math.min(hi, value));
}

function clamp01(value) {
    return clamp(Number.isFinite(value) ? value : 0.5, 0, 1);
}

export function isLeaf(node) {
    return !!node && node.kind === 'leaf';
}

/** 子树中最靠前（最左/最上）的叶子。 */
export function firstLeaf(node) {
    let n = node;
    while (n && n.kind === 'split')
        n = n.first;
    return n;
}

/** 子树中最靠后（最右/最下）的叶子。 */
export function lastLeaf(node) {
    let n = node;
    while (n && n.kind === 'split')
        n = n.second;
    return n;
}

export function subtreeContains(root, target) {
    if (!root)
        return false;
    if (root === target)
        return true;
    if (root.kind === 'leaf')
        return false;
    return subtreeContains(root.first, target) || subtreeContains(root.second, target);
}

export class LayoutTree {
    constructor({gap = 0, minSize = 120} = {}) {
        this.root = null;
        this.gap = gap;
        this.minSize = minSize;
        this._area = null;
        this._leafRects = new Map();
        this._nodeRects = new Map();
    }

    /* ------------------------------------------------------------------ 查询 */

    get isEmpty() {
        return this.root === null;
    }

    get area() {
        return this._area ? {...this._area} : null;
    }

    /** 按空间顺序返回所有叶子节点。 */
    leaves() {
        const out = [];
        const walk = node => {
            if (!node)
                return;
            if (node.kind === 'leaf') {
                out.push(node);
                return;
            }
            walk(node.first);
            walk(node.second);
        };
        walk(this.root);
        return out;
    }

    windows() {
        return this.leaves().map(leaf => leaf.window);
    }

    size() {
        return this.leaves().length;
    }

    findLeaf(window) {
        for (const leaf of this.leaves()) {
            if (leaf.window === window)
                return leaf;
        }
        return null;
    }

    findNodeById(id) {
        let found = null;
        const walk = node => {
            if (!node || found)
                return;
            if (node.id === id) {
                found = node;
                return;
            }
            if (node.kind === 'split') {
                walk(node.first);
                walk(node.second);
            }
        };
        walk(this.root);
        return found;
    }

    /** 最近一次 layout() 算出的窗口矩形。 */
    rectFor(window) {
        const rect = this._leafRects.get(window);
        return rect ? {...rect} : null;
    }

    nodeRect(node) {
        if (!node)
            return null;
        const rect = this._nodeRects.get(node.id);
        return rect ? {...rect} : null;
    }

    /* ---------------------------------------------------------------- 几何计算 */

    /**
     * 依据当前树结构计算所有窗口的矩形，并把结果缓存下来
     * （后续的 setEdge / boundaries / 落点判定都依赖这份缓存）。
     */
    layout(area) {
        this._leafRects = new Map();
        this._nodeRects = new Map();
        this._area = area ? {...area} : null;
        if (this.root && this._area)
            this._layoutNode(this.root, this._area);
        const out = new Map();
        for (const [window, rect] of this._leafRects)
            out.set(window, {...rect});
        return out;
    }

    _layoutNode(node, rect) {
        this._nodeRects.set(node.id, rect);
        if (node.kind === 'leaf') {
            this._leafRects.set(node.window, rect);
            return;
        }

        const gap = Math.max(0, Math.min(Math.round(this.gap),
            Math.floor(Math.min(rect.width, rect.height) / 4) || 0));

        if (node.orientation === 'h') {
            const available = Math.max(1, rect.width - gap);
            const minPx = Math.min(Math.round(this.minSize), Math.floor(available / 2));
            const width = clamp(Math.round(rect.width * clamp01(node.ratio)),
                minPx, Math.max(minPx, rect.width - gap - minPx));
            this._layoutNode(node.first, {x: rect.x, y: rect.y, width, height: rect.height});
            this._layoutNode(node.second, {
                x: rect.x + width + gap,
                y: rect.y,
                width: Math.max(1, rect.width - width - gap),
                height: rect.height,
            });
        } else {
            const available = Math.max(1, rect.height - gap);
            const minPx = Math.min(Math.round(this.minSize), Math.floor(available / 2));
            const height = clamp(Math.round(rect.height * clamp01(node.ratio)),
                minPx, Math.max(minPx, rect.height - gap - minPx));
            this._layoutNode(node.first, {x: rect.x, y: rect.y, width: rect.width, height});
            this._layoutNode(node.second, {
                x: rect.x,
                y: rect.y + height + gap,
                width: rect.width,
                height: Math.max(1, rect.height - height - gap),
            });
        }
    }

    /**
     * 两两相邻、并且可以直接插入新窗口的边界。
     * boundary.position 是边界线的坐标（'h' 为 x，'v' 为 y），
     * from/to 是这条边界线覆盖的范围。
     */
    boundaries() {
        const out = [];
        const walk = node => {
            if (!node || node.kind === 'leaf')
                return;
            const rect = this._nodeRects.get(node.id);
            const firstRect = this._nodeRects.get(node.first.id);
            const secondRect = this._nodeRects.get(node.second.id);
            if (rect && firstRect && secondRect) {
                const gap = node.orientation === 'h'
                    ? Math.max(0, secondRect.x - (firstRect.x + firstRect.width))
                    : Math.max(0, secondRect.y - (firstRect.y + firstRect.height));
                out.push({
                    split: node,
                    orientation: node.orientation,
                    before: lastLeaf(node.first),
                    after: firstLeaf(node.second),
                    // 边界线取两窗口之间空隙的中点
                    position: (node.orientation === 'h'
                        ? firstRect.x + firstRect.width
                        : firstRect.y + firstRect.height) + Math.round(gap / 2),
                    from: node.orientation === 'h' ? rect.y : rect.x,
                    to: node.orientation === 'h' ? rect.y + rect.height : rect.x + rect.width,
                });
            }
            walk(node.first);
            walk(node.second);
        };
        walk(this.root);
        return out;
    }

    /**
     * 求某个分界线在「沿线的某个坐标处」两侧真正相邻的两个窗口。
     *
     * 当一条分界线横贯屏幕（例如左侧一整列窗口贴着右侧一整列窗口）时，
     * 一条边界可能同时挨着好几个窗口；只有结合指针沿着边界的坐标，
     * 才能知道用户实际想插在哪两个窗口之间（需求 4 的补充要求）。
     */
    leavesAtBoundary(boundary, along) {
        const split = boundary.split;
        return {
            before: this._edgeLeaf(split.first, split.orientation, true, along),
            after: this._edgeLeaf(split.second, split.orientation, false, along),
        };
    }

    _edgeLeaf(node, orientation, fromFirst, along) {
        let current = node;
        while (current && current.kind === 'split') {
            if (current.orientation === orientation) {
                // 与分界线同方向排列：贴着这条边的孩子是固定的（第一个子树取最右/最下）
                current = fromFirst ? current.second : current.first;
                continue;
            }
            // 与分界线垂直排列：按指针沿线的坐标选择上/下（左/右）那一个
            const firstRect = this._nodeRects.get(current.first.id);
            const secondRect = this._nodeRects.get(current.second.id);
            if (!firstRect || !secondRect) {
                current = fromFirst ? current.second : current.first;
                continue;
            }
            const useFirst = current.orientation === 'h'
                ? along < firstRect.x + firstRect.width
                : along < firstRect.y + firstRect.height;
            current = useFirst ? current.first : current.second;
        }
        return current ?? node;
    }

    /* ---------------------------------------------------------------- 结构修改 */

    setSingleWindow(window) {
        const leaf = this.root && this.root.kind === 'leaf' && this.root.window === window
            ? this.root
            : makeLeaf(window);
        leaf.parent = null;
        this.root = leaf;
        this._invalidate();
        return leaf;
    }

    /** 把某个叶子的窗口换成另一个窗口（需求 2：新窗口接管焦点窗口的位置）。 */
    replaceWindow(oldWindow, newWindow) {
        const leaf = this.findLeaf(oldWindow);
        if (!leaf)
            return false;
        leaf.window = newWindow;
        this._invalidate();
        return true;
    }

    /** 交换两个窗口所占的位置（需求 4）。 */
    swapWindows(a, b) {
        if (a === b)
            return false;
        const leafA = this.findLeaf(a);
        const leafB = this.findLeaf(b);
        if (!leafA || !leafB)
            return false;
        leafA.window = b;
        leafB.window = a;
        this._invalidate();
        return true;
    }

    /**
     * 移除窗口：它的兄弟节点整体提升，空缺由兄弟子树吸收。
     * 这是「最小化后其余窗口自动占满空间」的实现。
     */
    removeWindow(window) {
        const leaf = this.findLeaf(window);
        if (!leaf)
            return false;

        const parent = leaf.parent;
        if (!parent) {
            this.root = null;
            leaf.parent = null;
            this._invalidate();
            return true;
        }

        const sibling = parent.first === leaf ? parent.second : parent.first;
        const grandParent = parent.parent;
        sibling.parent = grandParent;

        if (!grandParent)
            this.root = sibling;
        else if (grandParent.first === parent)
            grandParent.first = sibling;
        else
            grandParent.second = sibling;

        parent.first = null;
        parent.second = null;
        parent.parent = null;
        leaf.parent = null;
        this._invalidate();
        return true;
    }

    /**
     * 把一个节点一分为二，新窗口占其中一份。
     * before=true 时新窗口排在前面（左/上），否则排在后面（右/下）。
     * ratio 是「第一份」占总长度的比例。
     * orientation 可以强制切分方向（'h' 左右 / 'v' 上下），不传则按长边自动判断。
     *
     * node 不一定是窗口叶子，也可以是「一整组窗口」（例如一个分栏）：
     * 需求 4 往两个分栏之间插入新窗口时，切的就是相邻分栏那一整块区域，
     * 于是分栏里的每个窗口一起让位，宽度依然保持一致 —— 分栏还是分栏。
     */
    splitNode(node, newWindow, {before = false, ratio = 0.5, orientation = null} = {}) {
        if (!node)
            return null;

        const axis = orientation === 'h' || orientation === 'v'
            ? orientation
            : this._orientationFor(node);
        // 结构约束：行里不能再切出列。横向切分只允许发生在列一级，
        // 因此对分栏里的某个窗口做横向切分时，切成它所在的那一整列。
        const target = axis === 'h' ? this.columnRegion(node) : node;

        const parent = target.parent;
        const added = makeLeaf(newWindow);
        const split = before
            ? makeSplit(axis, clamp01(ratio), added, target, parent)
            : makeSplit(axis, clamp01(ratio), target, added, parent);

        if (!parent)
            this.root = split;
        else if (parent.first === target)
            parent.first = split;
        else
            parent.second = split;

        this._invalidate();
        return added;
    }

    /** 只切分窗口叶子；传进来的不是叶子就返回 null。 */
    splitLeafNode(leaf, newWindow, options = {}) {
        if (!leaf || leaf.kind !== 'leaf')
            return null;
        return this.splitNode(leaf, newWindow, options);
    }

    /** 按窗口查找并切分；找不到返回 null。 */
    splitWindow(window, newWindow, options = {}) {
        return this.splitLeafNode(this.findLeaf(window), newWindow, options);
    }

    /**
     * 「分栏」= 宽度相同、竖向排列的那一组窗口所在的区域（布局的第一层）。
     *
     * 空间布局是「屏幕 → 列 → 行」两层：从某个窗口往上走，在遇到第一条列与列之间的
     * 竖线（'h' 分割）之前的那一整块，就是它所在的分栏。窗口单独占一列时返回它自己。
     */
    columnRegion(node) {
        let current = node;
        while (current?.parent && current.parent.orientation === 'v')
            current = current.parent;
        return current;
    }

    /* ------------------------------------------------------------------ 尺寸联动 */

    /**
     * 需求 5：把窗口某条边的像素坐标写回布局（**比例联动**版）。
     * 找到与该方向对齐的最近祖先 split，改写它的比例；
     * 兄弟子树里的窗口会**按比例**吸收变化。
     *
     * 注意：真正的手动拖动用的是 setEdgeExact()。比例联动在嵌套结构下会连累
     * 到不挨着这条边的窗口（见 setEdgeExact 的说明），这里保留它是为了下面的
     * 单元测试能直接验证两种语义的差别。
     */
    setEdge(windowOrLeaf, edge, valuePx) {
        const hit = this._edgeSplit(windowOrLeaf, edge);
        if (!hit)
            return false;
        const {leaf, split, axis, leadingEdge} = hit;
        if (!split)
            return false;

        const rect = this._nodeRects.get(split.id);
        if (!rect)
            return false;

        const total = axis === 'h' ? rect.width : rect.height;
        const origin = axis === 'h' ? rect.x : rect.y;
        const gap = Math.min(Math.round(this.gap), Math.max(0, Math.floor(total / 4)));
        // 两边都只受通用最小值约束：分界线严格跟着指针（需求 5），
        // 某个窗口做不到更小/更大时，由复核之后的 _adoptActualSize 去迁就它，
        // 而不是在这里猜一个下限把分界线钉住。
        const edgeMin = Math.max(1, Math.round(this.minSize));
        const minPx = Math.min(edgeMin, Math.max(1, Math.floor((total - gap) / 2)));
        // 'e'/'s'：写的是第一个孩子的后边界；'w'/'n'：写的是第二个孩子的前边界（要扣掉间隔）。
        const offset = leadingEdge ? valuePx - origin : valuePx - origin - gap;
        const maxPx = Math.max(minPx, total - gap - edgeMin);
        const px = clamp(offset, minPx, maxPx);
        const next = clamp01(px / Math.max(1, total));
        // 比例没有实际变化（例如已经顶到最小尺寸的极限）时返回 false，
        // 免得调用方以为改动生效了而反复重试
        if (Math.abs(next - split.ratio) < 1e-9)
            return false;
        split.ratio = next;
        this._invalidate();
        return true;
    }

    /**
     * 需求 5（严格版）：把窗口某条边移动到 valuePx —— **只有紧挨着这条边的两侧
     * 那两块**（各自的「分栏」，即同宽的那一列 / 同一列里的那一行）改变尺寸，
     * 同一棵树里其它窗口的尺寸一点都不动。
     *
     * 为什么不能用比例联动：布局是「屏幕 → 列 → 行」两层，左边那几列整体是一棵
     * 子树。改这棵子树的比例会让**子树里所有**列按比例变化 —— 于是拖动「左中右」
     * 里中间那个窗口的右边框时，左边那列也会跟着变（用户看到的就是「意外调整了
     * 无关的窗口」）。上下排列时同理：拖动中间窗口的上边框会连累最下面那个窗口。
     *
     * 所以这里改成「按位移」：边界移动 Δ，由两侧相邻的分栏各自承担（一侧 +Δ、
     * 另一侧 -Δ），路径上其它兄弟保持原尺寸。两侧的相邻分栏都不会被压到小于
     * minSize（这一条决定了 Δ 的取值范围）。
     *
     * @returns {boolean} 布局是否真的变了
     */
    setEdgeExact(windowOrLeaf, edge, valuePx, {minSize = null} = {}) {
        const hit = this._edgeSplit(windowOrLeaf, edge);
        // hit.split 为 null 表示这条边本身就是工作区的边框，没有可分界的分割
        if (!hit || !hit.split)
            return false;
        const {leaf, split, axis, leadingEdge} = hit;

        const splitRect = this._nodeRects.get(split.id);
        const firstRect = this._nodeRects.get(split.first.id);
        const secondRect = this._nodeRects.get(split.second.id);
        if (!splitRect || !firstRect || !secondRect)
            return false;

        const wSide = subtreeContains(split.first, leaf) ? 'first' : 'second';
        // 两侧都往「边界方向」找：被拖动的窗口贴着这条边，另一侧紧挨着边界的那个
        // 分栏也贴着这条边 —— 这两块承担位移，路径上的兄弟保持原尺寸。
        // （每个子树里「边界方向」正好是另一个子树所在的那一侧。）
        const otherSide = wSide === 'first' ? 'second' : 'first';
        const wChain = this._absorbChain(split[wSide], axis, otherSide);
        const otherChain = this._absorbChain(split[otherSide], axis, wSide);
        if (!wChain || !otherChain)
            return false;

        // 边界此刻的位置：'e'/'s' 是第一个孩子的后边缘，'w'/'n' 是第二个孩子的前边缘
        // （'h' 看 x / width，'v' 看 y / height）
        const horizontal = axis === 'h';
        const boundary = leadingEdge
            ? (horizontal ? firstRect.x + firstRect.width : firstRect.y + firstRect.height)
            : (horizontal ? secondRect.x : secondRect.y);
        // minSize 允许调用方临时放宽（见 TilingManager._adoptEdge）：客户端的硬限制
        // 和「通用最小值」冲突时，优先保住用户没碰过的那一侧，把这一侧压小一点。
        const minUnit = Math.max(1, Math.round(minSize ?? this.minSize));
        const raw = Math.round(valuePx) - boundary;
        // 位移 Δ：被拖动那一侧的分栏承担 Δ，另一侧承担 -Δ；
        // 两侧都不能被压到低于最小值（否则让布局迁就谁都不成立，只能停在能到的位置）
        const deltaMin = leadingEdge
            ? minUnit - wChain.unitSize
            : minUnit - otherChain.unitSize;
        const deltaMaxRaw = leadingEdge
            ? otherChain.unitSize - minUnit
            : wChain.unitSize - minUnit;
        const deltaMax = Math.max(deltaMin, deltaMaxRaw);
        const delta = clamp(raw, deltaMin, deltaMax);
        if (delta === 0)
            return false;

        const total = axis === 'h' ? splitRect.width : splitRect.height;
        const origin = axis === 'h' ? splitRect.x : splitRect.y;
        const gap = Math.min(Math.round(this.gap), Math.max(0, Math.floor(total / 4)));
        const next = clamp01((boundary + delta - origin - (leadingEdge ? 0 : gap)) /
            Math.max(1, total));

        let moved = false;
        if (Math.abs(next - split.ratio) > 1e-9) {
            split.ratio = next;
            moved = true;
        }
        // 两侧各有一条「吸收链」：保持链上兄弟的尺寸不变，位移全给最里面那一块。
        // 两条都必须跑 —— 不能用 || 短路：被拖动那一侧有链时（嵌套结构），短路会把
        // 另一侧漏掉，那一侧就又变回按比例分配，连累到不挨着这条边的窗口。
        const movedW = this._absorbDelta(wChain, this._sideDelta(wSide, delta));
        const movedOther = this._absorbDelta(otherChain, this._sideDelta(otherSide, delta));
        if (movedW || movedOther)
            moved = true;

        this._invalidate();
        return moved;
    }

    /**
     * 某一侧拿到的位移：边界往「后」（右 / 下）移 δ 时，第一个孩子总是变大 δ、
     * 第二个孩子总是变小 δ —— 'e'/'s' 与 'w'/'n' 都是这个道理（边界是两者之间
     * 那条线，间隔是固定的）。
     */
    _sideDelta(side, delta) {
        return side === 'first' ? delta : -delta;
    }

    /**
     * 找出「离窗口这条边最近、且方向一致」的祖先 split。
     * @returns {{leaf, split, axis, leadingEdge}|null}
     */
    _edgeSplit(windowOrLeaf, edge) {
        const leaf = isLeaf(windowOrLeaf) ? windowOrLeaf : this.findLeaf(windowOrLeaf);
        if (!leaf)
            return null;
        const axis = edge === 'e' || edge === 'w' ? 'h' : 'v';
        const leadingEdge = edge === 'e' || edge === 's';
        let ancestor = leaf.parent;
        while (ancestor) {
            const inFirst = subtreeContains(ancestor.first, leaf);
            const inSecond = !inFirst && subtreeContains(ancestor.second, leaf);
            if (ancestor.orientation === axis &&
                ((leadingEdge && inFirst) || (!leadingEdge && inSecond)))
                return {leaf, split: ancestor, axis, leadingEdge};
            ancestor = ancestor.parent;
        }
        return {leaf, split: null, axis, leadingEdge};
    }

    /**
     * 从 node 往下、沿 axis 方向收集要「保持尺寸」的兄弟，
     * 直到遇到其它方向的节点（那就是承担位移的那一块：一个分栏）。
     *
     * @param {'first'|'second'} descend 往哪一边走（也就是哪一边承担位移）
     * @returns {{chain: Array, unitSize: number}|null}
     */
    _absorbChain(node, axis, descend) {
        if (!node)
            return null;
        const chain = [];
        let current = node;
        while (current.kind === 'split' && current.orientation === axis) {
            const keptIsFirst = descend === 'second';
            const kept = keptIsFirst ? current.first : current.second;
            const keptRect = this._nodeRects.get(kept.id);
            if (!keptRect)
                return null;
            chain.push({
                node: current,
                axis,
                keptIsFirst,
                keptSize: axis === 'h' ? keptRect.width : keptRect.height,
            });
            current = keptIsFirst ? current.second : current.first;
        }
        const unitRect = this._nodeRects.get(current.id);
        if (!unitRect)
            return null;
        return {
            chain,
            unit: current,
            unitSize: axis === 'h' ? unitRect.width : unitRect.height,
        };
    }

    /**
     * 拖动 window 的 edge 时，**允许改变尺寸**的窗口集合（只有这条边两侧相邻的
     * 那两块：一个分栏 / 一行），以及它所在的轴向。
     *
     * 供上层做「只能动这两块、其它窗口一点不能动」的运行期校验（见
     * TilingManager._onResizeProgress）：无论布局是什么形状，这个集合之外
     * 的窗口都不该有任何变化。
     *
     * @returns {{axis: 'h'|'v', split: object, own: object[], other: object[], windows: object[]}|null}
     */
    resizeUnits(windowOrLeaf, edge) {
        const hit = this._edgeSplit(windowOrLeaf, edge);
        if (!hit || !hit.split)
            return null;
        const {leaf, split, axis} = hit;
        const wSide = subtreeContains(split.first, leaf) ? 'first' : 'second';
        const otherSide = wSide === 'first' ? 'second' : 'first';
        const wChain = this._absorbChain(split[wSide], axis, otherSide);
        const otherChain = this._absorbChain(split[otherSide], axis, wSide);
        if (!wChain?.unit || !otherChain?.unit)
            return null;
        const own = this._windowsOf(wChain.unit);
        const other = this._windowsOf(otherChain.unit);
        return {axis, split, own, other, windows: [...own, ...other]};
    }

    /** 某个子树里的窗口（不含整棵树）。 */
    _windowsOf(node) {
        const out = [];
        const walk = current => {
            if (!current)
                return;
            if (current.kind === 'leaf') {
                out.push(current.window);
                return;
            }
            walk(current.first);
            walk(current.second);
        };
        walk(node);
        return out;
    }

    /** 记下所有 split 的比例（拖动一步之前用 restoreRatios 回滚）。 */
    snapshotRatios() {
        const out = new Map();
        const walk = node => {
            if (!node || node.kind === 'leaf')
                return;
            out.set(node, node.ratio);
            walk(node.first);
            walk(node.second);
        };
        walk(this.root);
        return out;
    }

    /** 把比例恢复成 snapshotRatios() 记下的样子。 */
    restoreRatios(snapshot) {
        let changed = false;
        for (const [node, ratio] of snapshot) {
            if (node.ratio !== ratio) {
                node.ratio = ratio;
                changed = true;
            }
        }
        if (changed)
            this._invalidate();
        return changed;
    }

    /**
     * 链上每一层的「兄弟」保持原尺寸，位移全部落到最里面那一块上。
     * 往下的每一层节点尺寸都正好变化 delta（兄弟和间隔都不变），
     * 所以按「老尺寸 + delta」重算比例即可。
     */
    _absorbDelta(info, delta) {
        let moved = false;
        for (const step of info.chain) {
            const rect = this._nodeRects.get(step.node.id);
            if (!rect)
                continue;
            const size = Math.max(1, (step.axis === 'h' ? rect.width : rect.height) + delta);
            const next = step.keptIsFirst
                ? clamp01(step.keptSize / size)
                : clamp01((size - step.keptSize) / size);
            if (Math.abs(next - step.node.ratio) > 1e-9) {
                step.node.ratio = next;
                moved = true;
            }
        }
        return moved;
    }

    /**
     * 让所有「分栏」（列）宽度相同。
     *
     * 布局是「屏幕 → 列 → 行」两层：列由根这一层的 'h' 分割串起来，每列的宽度由
     * 这些分割的比例决定。插入新分栏之后把比例按「各自还剩几列」重算一遍，就得到
     * 等宽的若干列；列内部的上下比例不受影响。
     */
    equalizeColumns() {
        const balance = node => {
            if (!node || node.kind === 'leaf' || node.orientation !== 'h')
                return;
            const total = this.columnCount(node);
            if (total > 0)
                node.ratio = this.columnCount(node.first) / total;
            balance(node.first);
            balance(node.second);
        };
        balance(this.root);
        this._invalidate();
    }

    /** 这份布局里有多少「分栏」（列）。 */
    columnCount(node = this.root) {
        if (!node)
            return 0;
        // 叶子是一列；'v' 分割（上下堆叠）整体也是一列
        if (node.kind === 'leaf' || node.orientation === 'v')
            return 1;
        return this.columnCount(node.first) + this.columnCount(node.second);
    }

    /** 一个子树里有多少「行」（'v' 方向上的窗口数）。 */
    rowCount(node = this.root) {
        return this._windowsOf(node).length;
    }

    /**
     * 把某一栏里的**行高均分**（在这一栏里插入新行、或者关掉一个窗口之后用）。
     *
     * 只动传进来的这一栏：别的分栏里用户手动拖出来的行高不受影响。
     * 行与行之间的间隔也扣掉，所以有 gap 时每一行的实际高度仍然相等。
     */
    equalizeRows(node = this.root) {
        if (!node || node.kind === 'leaf')
            return;
        // 有 gap 时每一层的可用高度取决于「这一层自己的矩形」，而修改上层比例会改变
        // 下层矩形 —— 所以迭代几次，直到比例稳定（通常两轮就够）。
        for (let pass = 0; pass < 4; pass++) {
            let changed = false;
            const balance = current => {
                if (!current || current.kind === 'leaf' || current.orientation !== 'v')
                    return;
                const rows = this.rowCount(current);
                const firstRows = this.rowCount(current.first);
                const rect = this._nodeRects.get(current.id);
                let ratio = current.ratio;
                if (rows > 0 && firstRows > 0) {
                    if (rect) {
                        const gap = Math.max(0, Math.min(Math.round(this.gap),
                            Math.floor(Math.min(rect.width, rect.height) / 4) || 0));
                        const content = Math.max(1, rect.height - (rows - 1) * gap);
                        const each = content / rows;
                        ratio = clamp01((firstRows * each + Math.max(0, firstRows - 1) * gap) /
                            Math.max(1, rect.height));
                    } else {
                        ratio = clamp01(firstRows / rows);
                    }
                }
                if (Math.abs(ratio - current.ratio) > 1e-9) {
                    current.ratio = ratio;
                    changed = true;
                }
                balance(current.first);
                balance(current.second);
            };
            balance(node);
            if (!changed)
                break;
            if (this._area)
                this.layout(this._area);
        }
        this._invalidate();
    }

    /* -------------------------------------------------------------------- 工具 */

    clone() {
        const copy = new LayoutTree({gap: this.gap, minSize: this.minSize});
        const cloneNode = (node, parent) => {
            if (!node)
                return null;
            if (node.kind === 'leaf')
                return {id: node.id, kind: 'leaf', window: node.window, parent};
            const split = {
                id: node.id,
                kind: 'split',
                orientation: node.orientation,
                ratio: node.ratio,
                parent,
                first: null,
                second: null,
            };
            split.first = cloneNode(node.first, split);
            split.second = cloneNode(node.second, split);
            return split;
        };
        copy.root = cloneNode(this.root, null);
        if (this._area)
            copy.layout(this._area);
        return copy;
    }

    /** 可读的结构描述，便于调试与测试断言。 */
    describe() {
        const walk = node => {
            if (!node)
                return null;
            if (node.kind === 'leaf')
                return node.window;
            return {
                orientation: node.orientation,
                ratio: Math.round(node.ratio * 1000) / 1000,
                first: walk(node.first),
                second: walk(node.second),
            };
        };
        return walk(this.root);
    }

    _orientationFor(leaf) {
        const rect = this._nodeRects.get(leaf.id);
        if (!rect)
            return 'h';
        // 沿着较长的一边切分，切出来的两块形状更接近。
        return rect.width >= rect.height ? 'h' : 'v';
    }

    /**
     * 结构或比例一旦变化，缓存的几何就失效了。
     * 主动清空可以让「忘记重新 layout()」立刻暴露出来（rectFor 返回 null），
     * 而不是悄悄读到过期的矩形。
     */
    _invalidate() {
        this._leafRects = new Map();
        this._nodeRects = new Map();
    }
}
