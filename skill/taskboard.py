#!/usr/bin/env python3
"""Vibe-TaskDeck 纯客户端模式的轻量包装器。

只管理本脚本写入 runtimeDir/widget-state.json 的挂件进程；
不按端口扫描或杀掉其他进程。全版看板为挂件内嵌本地页面
（Tauri 第二窗口直连 SQLite），无任何 Node server 依赖。
"""
from __future__ import annotations

import argparse
import ctypes
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time

MIN_NODE = (22, 5)
WIDGET_EXE_NAME = "taskdeck-widget.exe"


def project_root() -> Path:
    """定位工程/仓库根：优先向上找 .git，找不到则回退安装布局的 parents[3]。

    兼容两种布局：
      · 开发布局 <repo>/skill/taskboard.py → 仓库根（含 .git）
      · 安装布局 <工程>/.claude/skills/Vibe-TaskDeck/taskboard.py → 工程根
    """
    current = Path(__file__).resolve().parent
    for parent in [current, *current.parents]:
        if (parent / ".git").exists():
            return parent
    return Path(__file__).resolve().parents[3]


def runtime_dir(root: Path) -> Path:
    configured = os.environ.get("VIBE_TASKDECK_RUNTIME_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    return root / ".tmpfiles" / "Vibe-TaskDeck"


def widget_state_path(root: Path) -> Path:
    return runtime_dir(root) / "widget-state.json"


def data_dir(root: Path) -> Path:
    """任务数据目录：环境变量优先，默认 <repo>/.data。

    挂件（Rust 直连 SQLite）与 taskctl-local（Node 直连）共用同一数据库；
    启动两方时都应设置 VIBE_TASKDECK_DATA_DIR。
    """
    configured = os.environ.get("VIBE_TASKDECK_DATA_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    return root / ".data"


def load_widget_state(root: Path) -> dict:
    try:
        return json.loads(widget_state_path(root).read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def emit(value, as_json: bool) -> None:
    if as_json:
        print(json.dumps(value, ensure_ascii=False, indent=2))
    elif isinstance(value, str):
        print(value)
    else:
        for key, item in value.items():
            print(f"{key}: {item}")


def resolve_widget_dir(args, root: Path) -> Path | None:
    """解析挂件源码目录（用于定位构建产物与可执行文件）。"""
    configured = getattr(args, "widget_dir", None) or os.environ.get("VIBE_TASKDECK_WIDGET_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    default = root / "widget"
    return default if default.is_dir() else None


def resolve_widget_exe(args, root: Path) -> Path | None:
    """解析挂件可执行文件（用于 widget 启动）。"""
    configured = getattr(args, "widget_exe", None) or os.environ.get("VIBE_TASKDECK_WIDGET_EXE")
    if configured:
        return Path(configured).expanduser().resolve()
    widget_dir = resolve_widget_dir(args, root)
    if not widget_dir:
        return None
    exe = widget_dir / "src-tauri" / "target" / "x86_64-pc-windows-msvc" / "release" / WIDGET_EXE_NAME
    return exe if exe.is_file() else None


def node_version() -> tuple[int, int] | None:
    try:
        result = subprocess.run(["node", "--version"], capture_output=True, text=True, check=True)
        numbers = result.stdout.strip().lstrip("v").split(".")
        return int(numbers[0]), int(numbers[1])
    except (OSError, subprocess.SubprocessError, ValueError, IndexError):
        return None


def process_alive(pid) -> bool:
    if not isinstance(pid, int) or pid <= 0:
        return False
    if os.name == "nt":
        # Windows 上 os.kill(pid, 0) 对非零 pid 一律抛 EINVAL，无法用于存在性检查；
        # 改用 OpenProcess 查询进程句柄。
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        handle = ctypes.windll.kernel32.OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION, False, pid
        )
        if not handle:
            return False
        ctypes.windll.kernel32.CloseHandle(handle)
        return True
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError, OSError):
        return False


def status(args, root: Path) -> int:
    wstate = load_widget_state(root)
    wpid = wstate.get("pid")
    data = {
        "widgetRunning": process_alive(wpid),
        "widgetPid": wpid,
        "runtimeDir": str(runtime_dir(root)),
        "dataDir": str(data_dir(root)),
    }
    emit(data, args.json)
    return 0


def stop(args, root: Path, remove_runtime=False, purge=False, purge_data=False) -> int:
    # 先于运行目录清理读取挂件状态（purge 的 rmtree 会连带删除 widget-state.json）
    wstate = load_widget_state(root)
    stopped = False
    wpid = wstate.get("pid")
    if process_alive(wpid):
        try:
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(wpid), "/T", "/F"], check=False, capture_output=True)
            else:
                os.kill(wpid, signal.SIGTERM)
            stopped = True
        except OSError as exc:
            emit({"ok": False, "error": f"停止失败：{exc}", "pid": wpid}, args.json)
            return 1
    if widget_state_path(root).exists():
        widget_state_path(root).unlink()
    if purge:
        target = runtime_dir(root).resolve()
        allowed = (root / ".tmpfiles").resolve()
        if allowed not in target.parents or target == allowed:
            raise RuntimeError(f"拒绝清理非隔离目录：{target}")
        if target.exists():
            shutil.rmtree(target)
    elif remove_runtime:
        try:
            runtime_dir(root).rmdir()
        except OSError:
            pass
    data_removed = False
    if purge_data:
        # 显式删除任务数据库（taskboard.sqlite / -wal / -shm）；数据目录须位于仓库内。
        # 挂件进程持有 SQLite 连接会锁住文件（Windows），先停止托管挂件并等待退出。
        # wstate 在运行目录清理前已读取（见函数开头）。
        if process_alive(wpid):
            for _ in range(3):
                try:
                    if os.name == "nt":
                        subprocess.run(["taskkill", "/PID", str(wpid), "/T", "/F"], check=False, capture_output=True)
                    else:
                        os.kill(wpid, signal.SIGTERM)
                except OSError:
                    pass
                if not process_alive(wpid):
                    break
                time.sleep(1.0)
            if process_alive(wpid):
                emit({"ok": False, "error": f"挂件进程 {wpid} 未能停止，数据库文件被占用；请手动结束进程后重试。"}, args.json)
                return 1
            time.sleep(1.0)
        target_dir = data_dir(root)
        if root not in target_dir.parents and target_dir != root / ".data":
            raise RuntimeError(f"拒绝清理非仓库内数据目录：{target_dir}")
        for suffix in ("", "-wal", "-shm"):
            db_file = target_dir / f"taskboard.sqlite{suffix}"
            if not db_file.is_file():
                continue
            # 进程树刚被杀死时文件句柄释放有延迟（WebView2 子进程），退避重试
            for attempt in range(5):
                try:
                    db_file.unlink()
                    data_removed = True
                    break
                except PermissionError:
                    if attempt == 4:
                        raise
                    time.sleep(1.0)
    emit({"ok": True, "stopped": stopped, "purged": purge, "dataPurged": data_removed, "runtimeDir": str(runtime_dir(root)), "dataDir": str(data_dir(root))}, args.json)
    return 0


def taskctl(args, root: Path) -> int:
    """本地模式：直连 SQLite（cli/taskctl-local.mjs），不依赖任何 HTTP 服务。"""
    version = node_version()
    if version is None or version < MIN_NODE:
        emit({"ok": False, "error": "需要 Node.js 22.5+（node:sqlite）。"}, args.json)
        return 2
    script = root / "cli" / "taskctl-local.mjs"
    if not script.is_file():
        emit({"ok": False, "error": f"未找到 {script}"}, args.json)
        return 2
    env = os.environ.copy()
    env.setdefault("VIBE_TASKDECK_DATA_DIR", str(data_dir(root)))
    result = subprocess.run(["node", str(script), *args.taskctl_args], cwd=str(root), env=env, text=True)
    return result.returncode


def widget_start(args, root: Path) -> int:
    exe = resolve_widget_exe(args, root)
    if not exe:
        emit({"ok": False, "error": "未找到挂件可执行文件，请先构建（--widget-exe 或 VIBE_TASKDECK_WIDGET_EXE）。"}, args.json)
        return 2
    # 页面为编译期内嵌资源（frontendDist）：mini.html 与 fullboard.html 双产物，
    # 由 widget 下 npm run build 生成，随后 cargo build 嵌入 exe；运行期无需注入。
    widget_dir = resolve_widget_dir(args, root)
    if widget_dir and not (
        (widget_dir / "dist" / "mini.html").is_file()
        and (widget_dir / "dist" / "fullboard.html").is_file()
    ):
        emit({"ok": False, "error": "缺少 widget/dist/{mini,fullboard}.html，请先在 widget 下运行 npm run build 再 cargo build。"}, args.json)
        return 2
    env = os.environ.copy()
    env.setdefault("VIBE_TASKDECK_DATA_DIR", str(data_dir(root)))
    creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    try:
        proc = subprocess.Popen([str(exe)], env=env, creationflags=creationflags)
    except OSError as exc:
        emit({"ok": False, "error": f"挂件启动失败：{exc}"}, args.json)
        return 1
    wstate = {"pid": proc.pid, "exe": str(exe), "startedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
    runtime_dir(root).mkdir(parents=True, exist_ok=True)
    widget_state_path(root).write_text(json.dumps(wstate, ensure_ascii=False, indent=2), encoding="utf-8")
    emit({"ok": True, "pid": proc.pid, "exe": str(exe), "dataDir": str(data_dir(root))}, args.json)
    return 0


def widget_stop(args, root: Path) -> int:
    wstate = load_widget_state(root)
    pid = wstate.get("pid")
    stopped = False
    if process_alive(pid):
        try:
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], check=False, capture_output=True)
            else:
                os.kill(pid, signal.SIGTERM)
            stopped = True
        except OSError as exc:
            emit({"ok": False, "error": f"挂件停止失败：{exc}", "pid": pid}, args.json)
            return 1
    if widget_state_path(root).exists():
        widget_state_path(root).unlink()
    emit({"ok": True, "stopped": stopped}, args.json)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="管理 Vibe-TaskDeck 纯客户端模式（挂件 + 本地 taskctl）")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--widget-dir", help="挂件源码目录，也可用 VIBE_TASKDECK_WIDGET_DIR")
    parser.add_argument("--widget-exe", help="挂件可执行文件，也可用 VIBE_TASKDECK_WIDGET_EXE")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("status")
    sub.add_parser("stop")
    widget_parser = sub.add_parser("widget")
    widget_parser.add_argument("action", nargs="?", choices=["stop"], default=None)
    clean = sub.add_parser("clean")
    clean.add_argument("--keep-data", action="store_true")
    clean.add_argument("--purge", action="store_true")
    clean.add_argument("--purge-data", action="store_true", help="额外删除任务数据库（taskboard.sqlite*）")
    taskctl_parser = sub.add_parser("taskctl")
    taskctl_parser.add_argument("taskctl_args", nargs=argparse.REMAINDER)
    proj = sub.add_parser("project")
    proj.add_argument("taskctl_args", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    root = project_root()
    if args.command == "status":
        return status(args, root)
    if args.command == "stop":
        return stop(args, root)
    if args.command == "widget":
        if args.action == "stop":
            return widget_stop(args, root)
        return widget_start(args, root)
    if args.command == "clean":
        # 默认清理进程/日志/状态（不动任务数据）；--purge 连运行目录一起删；
        # --purge-data 额外显式删除任务数据库。
        purge = args.purge or not args.keep_data
        return stop(args, root, remove_runtime=args.keep_data, purge=purge, purge_data=args.purge_data)
    if args.command in ("taskctl", "project"):
        return taskctl(args, root)
    return 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        raise SystemExit(2)
