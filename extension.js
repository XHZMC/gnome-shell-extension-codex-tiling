// SPDX-License-Identifier: MIT
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {TilingIndicator} from './lib/indicator.js';
import {TilingManager} from './lib/tilingManager.js';

export default class CodexTilingExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._logger = this.getLogger();
        this._tiling = new TilingManager(this._settings, this._logger);
        this._tiling.enable();

        try {
            this._indicator = new TilingIndicator({
                settings: this._settings,
                onRetile: () => this._tiling?.retileAll({adopt: true}),
                onRestoreAll: () => this._tiling?.restoreAllMinimized(),
                // Extension 基类自带：打开本扩展的首选项页面
                onOpenSettings: () => this.openPreferences(),
            });
            this._indicator.enable();
        } catch (error) {
            // 面板指示器只是便利功能，失败不应该影响平铺本身
            this._logger.warn(`指示器创建失败，将继续使用平铺功能：${error}`);
            this._indicator = null;
        }
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        this._tiling?.disable();
        this._tiling = null;
        this._settings = null;
        this._logger = null;
    }

    /** 自动化测试入口（见 tests/live/run.sh）。 */
    get tiling() {
        return this._tiling ?? null;
    }
}
