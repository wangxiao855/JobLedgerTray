#!/usr/bin/env python3
"""JobLedger tray app: runs the local IMAP bridge without a console window."""

from __future__ import annotations

import datetime as dt
import os
import sys
import threading
import traceback
from pathlib import Path

import pystray
from PIL import Image, ImageDraw

from jobledger_mail import (
    ConfigError,
    get_meta,
    is_configured,
    load_config,
    make_handler,
    open_db,
    sync_with_lock,
)
from http.server import ThreadingHTTPServer

APP_NAME = "JobLedgerTray"
RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"


def data_dir() -> Path:
    if getattr(sys, "frozen", False):
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "JobLedger"
        base.mkdir(parents=True, exist_ok=True)
        return base
    return Path(__file__).resolve().parent


CONFIG_PATH = data_dir() / "config.json"
config = load_config(CONFIG_PATH)
server = None
STOP_EVENT = threading.Event()


def tray_image(size: int = 64) -> Image.Image:
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=14, fill=(11, 18, 32, 255))
    draw.rounded_rectangle(
        [13, 9, 43, 51],
        radius=5,
        fill=(17, 28, 51, 255),
        outline=(45, 212, 191, 255),
        width=2,
    )
    for y in (20, 27, 34):
        draw.line([19, y, 36, y], fill=(148, 163, 184, 255), width=2)
    draw.ellipse([34, 34, 56, 56], fill=(45, 212, 191, 255), outline=(11, 18, 32, 255), width=2)
    draw.line([39, 45, 43, 49, 51, 40], fill=(6, 32, 42, 255), width=3, joint="curve")
    return image


def status_text() -> str:
    try:
        connection = open_db(config["db_path"])
        try:
            last_error = get_meta(connection, "last_error")
            last_sync = get_meta(connection, "last_sync")
            count = connection.execute("SELECT COUNT(*) AS total FROM events").fetchone()["total"]
        finally:
            connection.close()
        if last_error:
            return "上次同步失败"
        if last_sync:
            return f"已同步 {count} 封邮件事件"
        return "等待第一次同步"
    except Exception:
        return "服务已启动"


def notify(icon: pystray.Icon, message: str, title: str = "投递簿 · 邮件同步") -> None:
    try:
        icon.notify(message, title)
    except Exception:
        pass


def log_error(message: str) -> None:
    try:
        with (data_dir() / "tray-error.log").open("a", encoding="utf-8") as handle:
            handle.write(message.rstrip() + "\n")
    except Exception:
        pass


def seconds_since_sync() -> float | None:
    try:
        connection = open_db(config["db_path"])
        try:
            last_sync = get_meta(connection, "last_sync")
        finally:
            connection.close()
        if not last_sync:
            return None
        parsed = dt.datetime.fromisoformat(last_sync.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=dt.timezone.utc)
        return max(0.0, (dt.datetime.now(dt.timezone.utc) - parsed).total_seconds())
    except Exception:
        return None


def sync_loop() -> None:
    """Background sync every 5 minutes, even if the browser is closed."""
    while not STOP_EVENT.wait(30):
        if not is_configured(config):
            continue
        age = seconds_since_sync()
        if age is not None and age < 240:
            continue
        try:
            sync_with_lock(config)
        except Exception as error:
            log_error(f"{dt.datetime.now().isoformat()} sync failed: {error}")


def start_server() -> ThreadingHTTPServer | None:
    global server
    host = config["http_host"] or "127.0.0.1"
    port = config["http_port"]
    try:
        server = ThreadingHTTPServer((host, port), make_handler(config))
    except OSError as error:
        return None
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def sync_now(icon: pystray.Icon, item=None) -> None:
    def worker() -> None:
        try:
            result = sync_with_lock(config)
            notify(
                icon,
                f"新增 {result.get('inserted', 0)} 封，忽略 {result.get('ignored', 0)} 封",
            )
        except Exception as error:
            notify(icon, "同步失败：" + str(error))

    threading.Thread(target=worker, daemon=True).start()


def startup_command() -> str:
    if getattr(sys, "frozen", False):
        return f'"{sys.executable}"'
    pythonw = Path(sys.executable).with_name("pythonw.exe")
    executable = pythonw if pythonw.exists() else Path(sys.executable)
    return f'"{executable}" "{Path(__file__).resolve()}"'


def startup_enabled() -> bool:
    if sys.platform != "win32":
        return False
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
            winreg.QueryValueEx(key, APP_NAME)
        return True
    except Exception:
        return False


def set_startup(enabled: bool) -> None:
    if sys.platform != "win32":
        return
    import winreg

    with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as key:
        if enabled:
            winreg.SetValueEx(key, APP_NAME, 0, winreg.REG_SZ, startup_command())
        else:
            try:
                winreg.DeleteValue(key, APP_NAME)
            except FileNotFoundError:
                pass


def toggle_startup(icon: pystray.Icon, item=None) -> None:
    enabled = not startup_enabled()
    try:
        set_startup(enabled)
        notify(icon, "已开启开机启动" if enabled else "已关闭开机启动")
    except Exception as error:
        notify(icon, "修改开机启动失败：" + str(error))


def quit_app(icon: pystray.Icon, item=None) -> None:
    global server
    STOP_EVENT.set()
    if server is not None:
        try:
            server.shutdown()
            server.server_close()
        except Exception:
            pass
    icon.stop()


def build_icon() -> pystray.Icon:
    menu = pystray.Menu(
        pystray.MenuItem(lambda item: "状态：" + status_text(), None, enabled=False),
        pystray.MenuItem("立即同步", sync_now),
        pystray.MenuItem("开机启动", toggle_startup, checked=lambda item: startup_enabled()),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("退出", quit_app),
    )
    return pystray.Icon(APP_NAME, tray_image(), "投递簿 · 邮件同步", menu)


def diagnose() -> int:
    import json
    import urllib.request

    print("JobLedger tray diagnostics", flush=True)
    print("frozen:", getattr(sys, "frozen", False), flush=True)
    print("executable:", sys.executable, flush=True)
    print("config:", CONFIG_PATH, flush=True)
    print("python:", sys.version, flush=True)
    try:
        print("pystray:", pystray.__file__, flush=True)
    except Exception as error:
        print("pystray error:", error, flush=True)
    try:
        started = start_server()
        print("server:", bool(started), "port:", config["http_port"], flush=True)
        if started is not None:
            with urllib.request.urlopen("http://127.0.0.1:8787/health", timeout=3) as response:
                print("health:", response.read().decode("utf-8"), flush=True)
            print("diagnose complete", flush=True)
            # The diagnostic process is not the tray process. Exit hard so a
            # blocked HTTP shutdown cannot leave a ghost process in Task Manager.
            os._exit(0)
        return 0
    except Exception as error:
        print("server error:", repr(error), flush=True)
        return 1


def main() -> int:
    if "--diagnose" in sys.argv:
        return diagnose()

    def on_setup(icon: pystray.Icon) -> None:
        icon.visible = True
        icon.update_menu()
        notify(
            icon,
            "已启动" if is_configured(config) else "请打开投递簿看板，在「邮件同步」里填写邮箱",
        )

    log_path = data_dir() / "tray-error.log"
    try:
        if start_server() is None:
            # Keep the tray alive so the user can see the error and exit.
            icon = build_icon()
            icon.run(setup=lambda icon: (
                setattr(icon, "visible", True),
                notify(icon, "端口 8787 被占用，服务没有启动"),
            ))
            return 1
        threading.Thread(target=sync_loop, daemon=True).start()
        icon = build_icon()
        icon.run(setup=on_setup)
        return 0
    except Exception:
        try:
            log_path.write_text(traceback.format_exc(), encoding="utf-8")
        except Exception:
            pass
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
