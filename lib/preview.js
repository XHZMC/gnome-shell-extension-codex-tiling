// SPDX-License-Identifier: MIT
/*
 * preview.js —— 拖动窗口时显示落点预览（需求 4 的可视化）。
 * 预览矩形直接用 planDrop() 算出的结果，因此和松手后的实际布局完全一致。
 */

import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/*
 * 落点预览分两种外观（都用 GNOME Shell 的主题色 -st-accent-color）：
 *
 *   · 贴边插入 / 交换位置：主题色淡填充 + 高亮实心边框，标出窗口会落在哪个格子；
 *   · **插到两个窗口之间**：直接高亮它们之间的那条间隙（细长实心条），
 *     而不是画一整个格子 —— 这里表达的是「新窗口会出现在这条缝里」。
 */
const STYLE_CLASS = 'codex-tiling-preview';
const GAP_STYLE_CLASS = 'codex-tiling-preview-gap';

export class DropPreview {
    constructor() {
        this._actor = new St.Widget({
            style_class: 'codex-tiling-preview',
            reactive: false,
            can_focus: false,
            visible: false,
            x_expand: false,
            y_expand: false,
        });
        this._destroyed = false;
        this._borderWidth = 6;
        // GNOME 45/46 用 add_actor()，47 之后是 add_child()
        if (typeof Main.uiGroup.add_child === 'function')
            Main.uiGroup.add_child(this._actor);
        else
            Main.uiGroup.add_actor(this._actor);
    }

    /**
     * 两种预览共用同一个「边框像素」：目标格子用 CSS 边框，间隙高亮用整条
     * 宽度等于这个值的实心条（间隙矩形由 planDrop() 按同一个值算出来）。
     */
    setBorderWidth(width) {
        const value = Math.max(1, Math.round(Number(width) || 6));
        this._borderWidth = value;
        if (!this._destroyed)
            this._actor.set_style(`border-width: ${value}px;`);
    }

    show(rect, {gap = false, borderWidth = null} = {}) {
        if (this._destroyed || !rect)
            return;
        if (borderWidth !== null)
            this.setBorderWidth(borderWidth);
        const styleClass = gap ? GAP_STYLE_CLASS : STYLE_CLASS;
        if (this._actor.style_class !== styleClass)
            this._actor.style_class = styleClass;
        this._actor.set_position(Math.round(rect.x), Math.round(rect.y));
        this._actor.set_size(
            Math.max(1, Math.round(rect.width)),
            Math.max(1, Math.round(rect.height)));
        this._actor.show();
    }

    hide() {
        if (!this._destroyed)
            this._actor.hide();
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._actor.destroy();
        this._actor = null;
    }
}
