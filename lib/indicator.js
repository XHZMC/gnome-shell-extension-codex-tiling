// SPDX-License-Identifier: MIT
/*
 * indicator.js —— 系统菜单里的开关和快捷操作。
 * 这个模型下窗口会被“藏”起来（最小化），所以提供一个「恢复所有最小化窗口」的入口，
 * 以及一个手动「重新平铺」的入口。
 */

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

const TilingToggle = GObject.registerClass(
class TilingToggle extends QuickSettings.QuickMenuToggle {
    _init(settings, {onRetile, onRestoreAll, onOpenSettings}) {
        super._init({
            title: '平铺窗口',
            subtitle: 'BSP 平铺',
            iconName: 'view-grid-symbolic',
            toggleMode: true,
        });

        this._settings = settings;
        settings.bind('enabled', this, 'checked', Gio.SettingsBindFlags.DEFAULT);

        // QuickMenuToggle.menu 是 PopupMenuBase，用 addMenuItem()；
        // 旧版本/其它容器的 API 叫 addItem()，这里两者都兼容。
        const addItem = item => {
            if (typeof this.menu.addMenuItem === 'function')
                this.menu.addMenuItem(item);
            else if (typeof this.menu.addItem === 'function')
                this.menu.addItem(item);
        };

        const retile = new PopupMenu.PopupMenuItem('重新平铺所有窗口');
        retile.connect('activate', () => onRetile?.());
        addItem(retile);

        addItem(new PopupMenu.PopupSeparatorMenuItem());

        const restore = new PopupMenu.PopupMenuItem('恢复所有最小化窗口');
        restore.connect('activate', () => onRestoreAll?.());
        addItem(restore);

        addItem(new PopupMenu.PopupSeparatorMenuItem());

        // 直接跳到本扩展的设置页面（等价于「扩展」应用里的齿轮按钮）
        const settingsItem = new PopupMenu.PopupMenuItem('平铺设置…');
        settingsItem.connect('activate', () => onOpenSettings?.());
        addItem(settingsItem);
    }
});

export class TilingIndicator {
    constructor(callbacks) {
        this._settings = callbacks.settings;
        this._callbacks = callbacks;
        this._indicator = null;
    }

    enable() {
        this._indicator = new QuickSettings.SystemIndicator();
        const toggle = new TilingToggle(this._settings, this._callbacks);
        this._indicator.quickSettingsItems.push(toggle);
        this._toggle = toggle;
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    destroy() {
        this._toggle?.menu?.destroy?.();
        this._toggle = null;
        if (this._indicator) {
            for (const item of this._indicator.quickSettingsItems)
                item.destroy();
            this._indicator.quickSettingsItems = [];
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
