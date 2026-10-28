// SPDX-License-Identifier: MIT
import Meta from 'gi://Meta';

/**
 * 判断一个窗口是否应该交给平铺管理器。
 *
 * 平铺布局排除三类窗口：最大化的（不参与平铺，布局被冻结，见 TilingManager）、
 * 最小化的（不参与平铺，腾出的空间由邻居吸收）、以及**对话框**等浮动窗口 ——
 * 它们保持 mutter 给的位置，既不参与平铺，也不受「窗口之间不能重叠」约束。
 */
/**
 * 返回「为什么不该平铺」：
 *
 *   'ok'       该平铺
 *   'type'     不是普通窗口 / override-redirect —— 结构性原因
 *   'dialog'   对话框、附属窗口、模态窗口 —— 结构性原因
 *   'floating' 不占任务栏、在所有桌面 —— 结构性原因
 *
 * 注意这里**不看**「跟屏幕一样大」：那个判据（is_monitor_sized / is_screen_sized）
 * 对刚退出全屏的窗口、以及「最大化过」的窗口同样成立，拿它驱逐会让窗口退出全屏 /
 * 取消最大化后再也回不到平铺里。窗口再大也只该被摆进它的格子里。
 */
export function tilingVerdict(window) {
    if (!window)
        return 'none';
    if (window.is_override_redirect?.() ?? false)
        return 'type';
    // 只接管普通窗口：DIALOG / MODAL_DIALOG / UTILITY / 各种菜单与通知都不算
    if (window.get_window_type?.() !== Meta.WindowType.NORMAL)
        return 'type';
    // 对话框（mutter 认定的「附属对话框」，包括各种工具包没有设 transient 的情况）
    if (window.is_attached_dialog?.() ?? false)
        return 'dialog';
    // 附属窗口（对话框、弹出面板）跟随父窗口浮动
    if (window.get_transient_for?.() ?? null)
        return 'dialog';
    // 附加的模态窗口：有些工具包只声明「模态」而不设 transient，也没有设成
    // DIALOG 类型。这个判据不是每个 mutter 版本都提供（本机 50 就没有），
    // 所以「存在即用」。
    if (window.is_modal?.() ?? false)
        return 'dialog';
    if (window.is_skip_taskbar?.() ?? false)
        return 'floating';
    if (window.is_on_all_workspaces?.() ?? false)
        return 'floating';
    return 'ok';
}

export function isTilableWindow(window) {
    return tilingVerdict(window) === 'ok';
}
