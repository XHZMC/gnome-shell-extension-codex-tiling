// SPDX-License-Identifier: MIT
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class CodexTilingPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: '平铺窗口',
            icon_name: 'view-grid-symbolic',
        });

        const general = new Adw.PreferencesGroup({
            title: '行为',
            description: '扩展会接管普通窗口的位置和大小；对话框与浮动窗口保持原样。',
        });

        general.add(this._switch(settings, 'enabled', '启用平铺管理',
            '关闭后彻底放手：不再改变窗口布局，并把系统自带的贴边吸附还回去。'));
        general.add(this._switch(settings, 'rearrange-existing-windows', '启用时重新排列已有窗口',
            '打开扩展时把当前窗口按平分方式平铺；关闭则只接管新窗口。'));
        general.add(this._switch(settings, 'show-preview', '拖动时显示落点预览', ''));
        general.add(this._switch(settings, 'show-overview-when-empty', '没有窗口时进入概览',
            '当前桌面上没有非最小化窗口时自动打开概览。'));
        general.add(this._spin(settings, 'preview-border-width', '落点预览边框（像素）', 1, 24, 1));

        const layout = new Adw.PreferencesGroup({title: '布局'});
        layout.add(this._spin(settings, 'gap', '窗口间距（像素）', 0, 48, 1));
        layout.add(this._spin(settings, 'outer-gap', '屏幕边缘留白（像素）', 0, 128, 1));
        layout.add(this._spin(settings, 'icon-area-inset', '底部图标停靠区留白（像素）', 0, 256, 2));
        layout.add(this._spin(settings, 'minimum-window-size', '窗口最小尺寸（像素）', 40, 800, 10));
        layout.add(this._spin(settings, 'edge-threshold', '边缘吸附距离（像素）', 4, 200, 2));

        const help = new Adw.PreferencesGroup({title: '鼠标操作'});
        help.add(new Adw.ActionRow({
            title: '拖到另一个窗口的左右边缘',
            subtitle: '在它这一列旁边插出一个新分栏（整列让出一半）',
        }));
        help.add(new Adw.ActionRow({
            title: '拖到另一个窗口的上下边缘',
            subtitle: '在它这一列里插出新的一行',
        }));
        help.add(new Adw.ActionRow({
            title: '拖到两个分栏之间',
            subtitle: '插出一个新分栏',
        }));
        help.add(new Adw.ActionRow({
            title: '拖到另一个窗口上',
            subtitle: '交换两个窗口的位置与大小',
        }));
        help.add(new Adw.ActionRow({
            title: '拖动窗口边缘',
            subtitle: '其余窗口联动调整大小',
        }));

        page.add(general);
        page.add(layout);
        page.add(help);
        window.add(page);
    }

    _switch(settings, key, title, subtitle) {
        const row = new Adw.SwitchRow({title, subtitle});
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _spin(settings, key, title, lower, upper, step) {
        const row = new Adw.SpinRow({
            title,
            adjustment: new Gtk.Adjustment({
                lower,
                upper,
                step_increment: step,
                page_increment: step * 5,
            }),
        });

        let updating = false;
        row.value = settings.get_int(key);
        row.connect('notify::value', () => {
            if (updating)
                return;
            settings.set_int(key, Math.round(row.value));
        });
        settings.connect(`changed::${key}`, () => {
            updating = true;
            row.value = settings.get_int(key);
            updating = false;
        });
        return row;
    }
}
