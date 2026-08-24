#!/usr/bin/env python3
"""隔离启动 dashi-taskboard 的轻量包装器。

只管理本脚本写入 runtimeDir/state.json 的进程；不会按端口扫描或杀掉其他进程。
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
import urllib.error
import urllib.request

MIN_NODE = (22, 5)
DEFAULT_PORT = 47823
DEFAULT_HOST = "127.0.0.1"
WIDGET_EXE_NAME = "dashi-taskboard-widget.exe"


def project_root() -> Path:
    """定位工程/仓库根：优先向上找 .git，找不到则回退安装布局的 parents[3]。

    兼容两种布局：
      · 开发布局 <repo>/skill/taskboard.py → 仓库根（含 .git）
      · 安装布局 <工程>/.claude/skills/dashi-taskboard/taskboard.py → 工程根
    """
    current = Path(__file__).resolve().parent
    for parent in [current, *current.parents]:
        if (parent / ".git").exists():
            return parent
    return Path(__file__).resolve().parents[3]


def runtime_dir(root: Path) -> Path:
    configured = os.environ.get("DASHI_TASKBOARD_RUNTIME_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    return root / ".tmpfiles" / "dashi-taskboard"


def state_path(root: Path) -> Path:
    return runtime_dir(root) / "state.json"


def load_state(root: Path) -> dict:
    try:
        return json.loads(state_path(root).read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def widget_state_path(root: Path) -> Path:
    return runtime_dir(root) / "widget-state.json"


def data_dir(root: Path) -> Path:
    """任务数据目录：环境变量优先，默认 <repo>/.data。

    挂件（Rust 直连 SQLite）、taskctl-local（Node 直连）与可选的 server 模式
    三方共用同一数据库文件；启动三方时都应设置 CODEX_TASKBOARD_DATA_DIR。
    """
    configured = os.environ.get("CODEX_TASKBOARD_DATA_DIR")
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


def resolve_source(args, root: Path) -> Path | None:
    source = args.source or os.environ.get("DASHI_TASKBOARD_SOURCE")
    if not source:
        return None
    return Path(source).expanduser().resolve()


def resolve_widget_dir(args, root: Path) -> Path | None:
    """解析挂件源码目录（用于构建挂件页面）。"""
    configured = getattr(args, "widget_dir", None) or os.environ.get("DASHI_TASKBOARD_WIDGET_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    default = root / "widget"
    return default if default.is_dir() else None


def resolve_widget_exe(args, root: Path) -> Path | None:
    """解析挂件可执行文件（用于 widget 启动）。"""
    configured = getattr(args, "widget_exe", None) or os.environ.get("DASHI_TASKBOARD_WIDGET_EXE")
    if configured:
        return Path(configured).expanduser().resolve()
    widget_dir = resolve_widget_dir(args, root)
    if not widget_dir:
        return None
    exe = widget_dir / "src-tauri" / "target" / "x86_64-pc-windows-msvc" / "release" / WIDGET_EXE_NAME
    return exe if exe.is_file() else None


def prepare_widget_page(source: Path, widget_dir: Path) -> str | None:
    """构建挂件单文件页面到 widget/dist/mini.html（frontendDist 编译期嵌入 exe 用）。

    返回 None 表示无构建脚本或构建失败（调用方静默跳过）。
    注意：页面是 cargo build 时嵌入 exe 的，运行期重建不影响已编译的 exe；
    改动挂件 web 源码后需要「build-widget → cargo build」两步重跑。
    """
    script = widget_dir / "scripts" / "build-widget.mjs"
    if not script.is_file():
        return None
    result = subprocess.run(["node", str(script)], capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode != 0:
        return None
    built = widget_dir / "dist" / "mini.html"
    return "built" if built.is_file() else None


def node_version() -> tuple[int, int] | None:
    try:
        result = subprocess.run(["node", "--version"], capture_output=True, text=True, check=True)
        numbers = result.stdout.strip().lstrip("v").split(".")
        return int(numbers[0]), int(numbers[1])
    except (OSError, subprocess.SubprocessError, ValueError, IndexError):
        return None


def url_for(args) -> str:
    return f"http://{args.host}:{args.port}/"


def reachable(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=1.2) as response:
            return 200 <= response.status < 500
    except urllib.error.HTTPError as exc:
        # 服务根路径可能返回 404，但 HTTP 响应本身证明服务已监听。
        return 400 <= exc.code < 500
    except (urllib.error.URLError, TimeoutError, OSError):
        return False


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
    state = load_state(root)
    pid = state.get("pid")
    wstate = load_widget_state(root)
    wpid = wstate.get("pid")
    data = {
        "running": process_alive(pid),
        "reachable": reachable(state.get("url", url_for(args))),
        "pid": pid,
        "url": state.get("url", url_for(args)),
        "source": state.get("source") or (str(resolve_source(args, root)) if resolve_source(args, root) else None),
        "runtimeDir": str(runtime_dir(root)),
        "log": state.get("log"),
        "dataDir": str(data_dir(root)),
        "widgetRunning": process_alive(wpid),
        "widgetPid": wpid,
    }
    emit(data, args.json)
    return 0


def validate_source(source: Path | None) -> tuple[bool, str]:
    if source is None:
        return False, "未指定 dashi-taskboard 源码目录，请传 --source 或设置 DASHI_TASKBOARD_SOURCE。"
    if not (source / "package.json").is_file():
        return False, f"源码目录不存在 package.json：{source}"
    if not (source / "server" / "index.mjs").is_file():
        return False, f"源码目录缺少 server/index.mjs：{source}"
    if not (source / "node_modules").is_dir():
        return False, "尚未安装依赖，请在 dashi-taskboard 源码目录执行 npm install。"
    return True, ""


def start(args, root: Path) -> int:
    version = node_version()
    if version is None:
        emit({"ok": False, "error": "未找到 node。需要 Node.js 22.5+。"}, args.json)
        return 2
    if version < MIN_NODE:
        emit({"ok": False, "error": f"Node.js 版本过低：{version[0]}.{version[1]}，需要 22.5+。"}, args.json)
        return 2

    source = resolve_source(args, root)
    valid, error = validate_source(source)
    if not valid:
        emit({"ok": False, "error": error}, args.json)
        return 2

    # 构建挂件页面（frontendDist 编译期产物；此处仅确保 dist 存在便于下次 cargo build）
    widget_dir = resolve_widget_dir(args, root)
    if widget_dir:
        prepare_widget_page(source, widget_dir)

    existing = load_state(root)
    existing_pid = existing.get("pid")
    existing_url = existing.get("url", url_for(args))
    if process_alive(existing_pid) and reachable(existing_url):
        emit({"ok": True, "reused": True, "pid": existing_pid, "url": existing_url}, args.json)
        return 0

    run_dir = runtime_dir(root)
    run_dir.mkdir(parents=True, exist_ok=True)
    log_path = run_dir / "server.log"
    log = log_path.open("ab")
    env = os.environ.copy()
    env.setdefault("CODEX_TASKBOARD_HOST", args.host)
    env.setdefault("CODEX_TASKBOARD_PORT", str(args.port))
    # server 模式与挂件 / taskctl-local 共用同一数据库（纯客户端三端同库）
    env.setdefault("CODEX_TASKBOARD_DATA_DIR", str(data_dir(root)))
    # CREATE_NO_WINDOW：被无控制台的调用方（挂件 exe）拉起时不弹「Python/node」黑窗；
    # CREATE_NEW_PROCESS_GROUP：独立进程组便于 stop 定向终止。server 输出已重定向到日志，不依赖控制台。
    creationflags = (
        getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        | getattr(subprocess, "CREATE_NO_WINDOW", 0)
    )
    # 直接启动 node 进程，避免 npm.cmd 包装器导致托管 pid 与监听进程不一致。
    command = ["node", "server/index.mjs"]
    try:
        proc = subprocess.Popen(
            command, cwd=source, env=env, stdout=log, stderr=subprocess.STDOUT,
            creationflags=creationflags,
        )
    except OSError as exc:
        log.close()
        emit({"ok": False, "error": f"启动失败：{exc}", "log": str(log_path)}, args.json)
        return 1
    finally:
        log.close()

    url = url_for(args)
    state = {"pid": proc.pid, "source": str(source), "url": url, "log": str(log_path), "startedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
    state_path(root).write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    deadline = time.time() + args.timeout
    while time.time() < deadline:
        if reachable(url):
            emit({"ok": True, "reused": False, "pid": proc.pid, "url": url, "log": str(log_path)}, args.json)
            return 0
        if proc.poll() is not None:
            break
        time.sleep(0.25)
    emit({"ok": False, "error": "服务未在超时内就绪，请检查日志。", "pid": proc.pid, "url": url, "log": str(log_path)}, args.json)
    return 1


def stop(args, root: Path, remove_runtime=False, purge=False, purge_data=False) -> int:
    state = load_state(root)
    pid = state.get("pid")
    # 先于运行目录清理读取挂件状态（purge 的 rmtree 会连带删除 widget-state.json）
    wstate = load_widget_state(root)
    stopped = False
    if process_alive(pid):
        try:
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], check=False, capture_output=True)
            else:
                os.kill(pid, signal.SIGTERM)
            stopped = True
        except OSError as exc:
            emit({"ok": False, "error": f"停止失败：{exc}", "pid": pid}, args.json)
            return 1
    if state_path(root).exists():
        state_path(root).unlink()
    if purge:
        target = runtime_dir(root).resolve()
        allowed = (root / ".tmpfiles").resolve()
        if allowed not in target.parents or target == allowed:
            raise RuntimeError(f"拒绝清理非隔离目录：{target}")
        if target.exists():
            shutil.rmtree(target)
    elif remove_runtime:
        log = state.get("log")
        if log:
            Path(log).unlink(missing_ok=True)
        try:
            runtime_dir(root).rmdir()
        except OSError:
            pass
    data_removed = False
    if purge_data:
        # 显式删除任务数据库（taskboard.sqlite / -wal / -shm）；数据目录须位于仓库内。
        # 挂件进程持有 SQLite 连接会锁住文件（Windows），先停止托管挂件并等待退出。
        # wstate 在运行目录清理前已读取（见函数开头）。
        wpid = wstate.get("pid")
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
        if widget_state_path(root).exists():
            widget_state_path(root).unlink()
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
    env.setdefault("CODEX_TASKBOARD_DATA_DIR", str(data_dir(root)))
    result = subprocess.run(["node", str(script), *args.taskctl_args], cwd=str(root), env=env, text=True)
    return result.returncode


def _ensure_companion(args, root: Path) -> tuple[bool, str]:
    """确保 companion server（本地 taskboard 服务）在运行——cloud-session API 的宿主。

    cloud 模式的会话配置与请求代理都在本地 server（app.mjs）里；
    源码目录未显式指定时回退仓库内 upstream/（只读快照，npm 依赖已就绪即可用）。
    返回 (ok, base_url)。
    """
    state = load_state(root)
    base_url = state.get("url", url_for(args))
    if process_alive(state.get("pid")) and reachable(base_url):
        return True, base_url
    if not (getattr(args, "source", None) or os.environ.get("DASHI_TASKBOARD_SOURCE")):
        default_source = root / "upstream"
        if (default_source / "server" / "index.mjs").is_file():
            args.source = str(default_source)
    code = start(args, root)
    if code:
        return False, base_url
    state = load_state(root)
    return True, state.get("url", base_url)


def _cloud_request(base_url: str, method: str, payload: dict | None = None) -> tuple[int, dict]:
    """调用 companion 的 /api/local/cloud-session；返回 (http_status, json_body)。"""
    url = f"{base_url.rstrip('/')}/api/local/cloud-session"
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        request.add_header("content-type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            body = response.read().decode("utf-8")
            return response.status, json.loads(body) if body else {}
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        try:
            return exc.code, json.loads(body)
        except json.JSONDecodeError:
            return exc.code, {"error": {"message": body[:200]}}
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return 0, {"error": {"message": f"companion 不可达：{exc}"}}


def cloud_login(args, root: Path) -> int:
    """登录云端：配置 cloud-session（remoteUrl + actorName + sharedKey）。

    密码来源：--shared-key 参数（AI 场景）或 SHARED_KEY 环境变量；
    不做交互式输入（上游 CLI 的 setRawMode 在非 TTY 下不可用）。
    """
    ok, base_url = _ensure_companion(args, root)
    if not ok:
        emit({"ok": False, "error": "companion server 启动失败，无法登录云端。"}, args.json)
        return 1
    remote_url = args.cloud_remote or os.environ.get("TASKBOARD_CLOUD_URL")
    actor = args.cloud_actor or os.environ.get("TASKBOARD_CLOUD_ACTOR")
    shared_key = args.cloud_key or os.environ.get("TASKBOARD_CLOUD_SHARED_KEY")
    missing = [name for name, value in (("url", remote_url), ("actor-name", actor), ("shared-key", shared_key)) if not value]
    if missing:
        emit({"ok": False, "error": f"缺少云端登录参数：{', '.join(missing)}。请传 --url/--actor-name/--shared-key 或设置 TASKBOARD_CLOUD_URL/TASKBOARD_CLOUD_ACTOR/TASKBOARD_CLOUD_SHARED_KEY。"}, args.json)
        return 2
    status_code, body = _cloud_request(base_url, "PUT", {
        "remoteUrl": remote_url,
        "actorName": actor,
        "sharedKey": shared_key,
    })
    if status_code != 200:
        error = body.get("error", {})
        emit({"ok": False, "error": f"云端登录失败（HTTP {status_code}）：{error.get('message', body)}"}, args.json)
        return 1
    emit({"ok": True, **{k: body.get(k) for k in ("mode", "remoteUrl", "actorName", "authenticated")}}, args.json)
    return 0


def cloud_status(args, root: Path) -> int:
    """查询云端会话状态（不要求已登录）。"""
    ok, base_url = _ensure_companion(args, root)
    if not ok:
        emit({"ok": False, "error": "companion server 启动失败。"}, args.json)
        return 1
    status_code, body = _cloud_request(base_url, "GET")
    if status_code != 200:
        emit({"ok": False, "error": f"查询失败（HTTP {status_code}）：{body}"}, args.json)
        return 1
    emit({"ok": True, **body}, args.json)
    return 0


def cloud_logout(args, root: Path) -> int:
    """退出云端模式，回到本地数据模式（不合并云端数据）。"""
    ok, base_url = _ensure_companion(args, root)
    if not ok:
        emit({"ok": False, "error": "companion server 启动失败。"}, args.json)
        return 1
    status_code, body = _cloud_request(base_url, "DELETE")
    if status_code != 200:
        emit({"ok": False, "error": f"退出失败（HTTP {status_code}）：{body}"}, args.json)
        return 1
    emit({"ok": True, **body}, args.json)
    return 0


def widget_start(args, root: Path) -> int:
    exe = resolve_widget_exe(args, root)
    if not exe:
        emit({"ok": False, "error": "未找到挂件可执行文件，请先构建（--widget-exe 或 DASHI_TASKBOARD_WIDGET_EXE）。"}, args.json)
        return 2
    # 页面为编译期内嵌资源（frontendDist）：提醒构建时序，运行期无需注入。
    widget_dir = resolve_widget_dir(args, root)
    if widget_dir and not (widget_dir / "dist" / "mini.html").is_file():
        emit({"ok": False, "error": "缺少 widget/dist/mini.html，请先运行 node widget/scripts/build-widget.mjs 再 cargo build。"}, args.json)
        return 2
    env = os.environ.copy()
    env.setdefault("CODEX_TASKBOARD_DATA_DIR", str(data_dir(root)))
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
    parser = argparse.ArgumentParser(description="隔离管理 dashi-taskboard 本地试用服务")
    parser.add_argument("--source", help="dashi-taskboard 源码目录，也可用 DASHI_TASKBOARD_SOURCE")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--timeout", type=float, default=20)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--widget-dir", help="挂件源码目录，也可用 DASHI_TASKBOARD_WIDGET_DIR")
    parser.add_argument("--widget-exe", help="挂件可执行文件，也可用 DASHI_TASKBOARD_WIDGET_EXE")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("status")
    sub.add_parser("start")
    sub.add_parser("open")
    sub.add_parser("stop")
    widget_parser = sub.add_parser("widget")
    widget_parser.add_argument("action", nargs="?", choices=["stop"], default=None)
    clean = sub.add_parser("clean")
    clean.add_argument("--keep-data", action="store_true")
    clean.add_argument("--purge", action="store_true")
    clean.add_argument("--purge-data", action="store_true", help="额外删除任务数据库（taskboard.sqlite*）")
    taskctl_parser = sub.add_parser("taskctl")
    taskctl_parser.add_argument("taskctl_args", nargs=argparse.REMAINDER)
    cloud_parser = sub.add_parser("cloud")
    cloud_parser.add_argument("action", choices=["login", "status", "logout"], default="status", nargs="?")
    cloud_parser.add_argument("--url", dest="cloud_remote", help="云端看板地址（如 https://taskboard.example.com）")
    cloud_parser.add_argument("--actor-name", dest="cloud_actor", help="显示在看板上的操作者名字")
    cloud_parser.add_argument("--shared-key", dest="cloud_key", help="云端共享密码（或 TASKBOARD_CLOUD_SHARED_KEY 环境变量）")
    proj = sub.add_parser("project")
    proj.add_argument("taskctl_args", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    root = project_root()
    if args.command == "status":
        return status(args, root)
    if args.command == "start":
        return start(args, root)
    if args.command == "open":
        code = start(args, root)
        if code:
            return code
        url = url_for(args)
        try:
            os.startfile(url)  # type: ignore[attr-defined]
        except (AttributeError, OSError):
            print(f"请在浏览器打开：{url}")
        return 0
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
    if args.command == "cloud":
        if args.action == "login":
            return cloud_login(args, root)
        if args.action == "logout":
            return cloud_logout(args, root)
        return cloud_status(args, root)
    return 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        raise SystemExit(2)
