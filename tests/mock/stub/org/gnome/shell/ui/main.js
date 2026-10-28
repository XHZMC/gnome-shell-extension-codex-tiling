// Minimal stand-in for shell/ui/main.js so lib/tilingManager.js can be exercised
// outside a running GNOME Shell (see tests/mock/run.sh).

const counters = globalThis.__shellStubCounters ??= {uiGroupChildren: 0};

export const uiGroup = {
    add_child(_actor) {
        counters.uiGroupChildren++;
    },
    remove_child(_actor) {
        counters.uiGroupChildren--;
    },
};

export const layoutManager = {
    monitors: [{x: 0, y: 0, width: 1280, height: 800, index: 0}],
};

export const panel = {statusArea: {quickSettings: {addExternalIndicator() {}}}};

// 真的 Overview 是一个带 'showing' / 'shown' / 'hiding' / 'hidden' 信号的 actor，
// 扩展会连 'hidden' 来做「概览期间延后的动作」。这里给个最小可用的信号实现。
const overviewHandlers = new Map();
let nextOverviewHandle = 1;
export const overview = {
    visible: false,
    connect(name, callback) {
        const id = nextOverviewHandle++;
        if (!overviewHandlers.has(name))
            overviewHandlers.set(name, new Map());
        overviewHandlers.get(name).set(id, callback);
        return id;
    },
    disconnect(id) {
        for (const handlers of overviewHandlers.values())
            handlers.delete(id);
    },
    _emit(name) {
        for (const callback of [...(overviewHandlers.get(name)?.values() ?? [])])
            callback();
    },
    show() {
        this.visible = true;
        this._emit('showing');
    },
    hide() {
        const wasVisible = this.visible;
        this.visible = false;
        if (wasVisible)
            this._emit('hidden');   // 真的 shell 也在动画结束之后才发这个信号
    },
};

export const sessionMode = {currentMode: 'user'};
