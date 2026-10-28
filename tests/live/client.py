#!/usr/bin/env python3
"""测试用的极简 GTK4 客户端：打开一个窗口并一直运行，直到被结束。

用法: client.py <标题> [宽] [高] [--maximize] [--dialog]

  --maximize   打开后自己调用 maximize()，模拟「应用启动时主动最大化」
  --dialog     额外打开一个附属对话框（transient + modal），用来验证对话框不参与平铺
  --fullscreen 打开后进入全屏，过几秒再退出（验证退出全屏后回到平铺）
  --file-dialog 打开一个文件选择器（Wayland 下会走 portal，窗口属于另一个进程、
                父窗口关系是异步接上的，用来验证「迟到的对话框」也会退出平铺）
"""
import sys

import gi

gi.require_version('Gtk', '4.0')
from gi.repository import Gtk  # noqa: E402


def main():
    argv = [arg for arg in sys.argv[1:] if not arg.startswith('--')]
    flags = {arg for arg in sys.argv[1:] if arg.startswith('--')}
    title = argv[0] if argv else 'W'
    width = int(argv[1]) if len(argv) > 1 else 600
    height = int(argv[2]) if len(argv) > 2 else 400

    app = Gtk.Application(application_id=None)

    def on_activate(application):
        window = Gtk.ApplicationWindow(application=application, title=title)
        window.set_default_size(width, height)
        window.set_child(Gtk.Label(label=title))
        window.present()
        if '--maximize' in flags:
            window.maximize()
        if '--dialog' in flags:
            dialog = Gtk.Window(transient_for=window, modal=True, title=f'{title}-dialog')
            dialog.set_default_size(320, 200)
            dialog.set_child(Gtk.Label(label='dialog'))
            dialog.present()
        if '--fullscreen' in flags:
            window.fullscreen()
        if '--file-dialog' in flags:
            chooser = Gtk.FileDialog(title='Open File')
            chooser.open(window, None, lambda *args: None)

    app.connect('activate', on_activate)
    app.run([])


if __name__ == '__main__':
    main()
