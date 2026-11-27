"""统一定位 ffmpeg/ffprobe 可执行文件。

解析顺序：FFMPEG_PATH 环境变量 → Release 包内 tools/ffmpeg → PATH → conda 环境。
云端 Docker 无 tools/ 目录，自动落到 PATH；开发机 conda 走最后一条。
"""
from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
BUNDLED_FFMPEG_DIR = _REPO_ROOT / "tools" / "ffmpeg"
BUNDLED_VCREDIST_DIR = _REPO_ROOT / "tools" / "vcredist"


def enable_bundled_runtime() -> None:
    """把 Release 包内的运行时 DLL 目录加入 Windows DLL 搜索路径。

    Python 3.8+ 解析 ctypes/pyd 依赖时不再查 PATH 和 exe 所在目录，只认
    ``os.add_dll_directory()``。未装 VC++ 2015-2022 Redistributable 的干净
    Windows 上 ctranslate2.dll 会因缺 msvcp140.dll 加载失败（Whisper 全挂），
    因此 Release 打包 tools/vcredist 并在这里登记。tesseract/ffmpeg 目录一
    并登记，便于其依赖解析；目录不存在时静默跳过（云端/开发环境无 tools/）。
    必须在 import ctranslate2 / faster_whisper 之前调用。
    """
    if os.name != "nt" or not hasattr(os, "add_dll_directory"):
        return
    for directory in (BUNDLED_VCREDIST_DIR, BUNDLED_FFMPEG_DIR, _REPO_ROOT / "tools" / "tesseract"):
        try:
            if directory.is_dir() and not _has_lfs_pointer_dll(directory):
                os.add_dll_directory(str(directory))
        except OSError:
            continue
    _preload_newest_msvcp140()


_LFS_POINTER_PREFIX = b"version https://git-lfs"


def _has_lfs_pointer_dll(directory: Path) -> bool:
    """源码检出未执行 git lfs pull 时，tools/ 下的 DLL 只是几百字节的文本指针。
    这种目录一旦登记进 DLL 搜索路径，按名加载（如 msvcp140_1.dll）会命中指针文件，
    报 "%1 is not a valid Win32 application"，onnxruntime/ctranslate2 全部加载失败。"""
    for dll in directory.glob("*.dll"):
        try:
            if dll.stat().st_size < 1024:
                with dll.open("rb") as fh:
                    if fh.read(len(_LFS_POINTER_PREFIX)) == _LFS_POINTER_PREFIX:
                        return True
        except OSError:
            continue
    return False


# VS 2022 17.10+ 编译的原生库（onnxruntime 1.2x+、ctranslate2 等）在 14.40 以下的
# msvcp140.dll 上会在 std::mutex 处 0xc0000005 崩溃，整个服务器进程直接退出
# （前端表现为 "Failed to fetch"）。Anaconda 等发行版在 python.exe 同目录自带旧版
# msvcp140.dll，而 Windows 加载器优先查应用目录，add_dll_directory 无法覆盖。
# 解决：在任何原生库导入前，按完整路径预加载已知最新的 msvcp140.dll——同名模块
# 已在进程内时，后续按名解析都会复用它。
_MIN_MSVCP140_VERSION = (14, 40)


def _dll_file_version(path: Path) -> tuple[int, int, int, int] | None:
    """读取 DLL 的 FileVersion；非有效 PE（如未拉取的 Git LFS 指针）返回 None。"""
    import ctypes
    from ctypes import wintypes

    version = ctypes.WinDLL("version")
    size = version.GetFileVersionInfoSizeW(str(path), None)
    if not size:
        return None
    buf = ctypes.create_string_buffer(size)
    if not version.GetFileVersionInfoW(str(path), 0, size, buf):
        return None
    ptr = ctypes.c_void_p()
    length = wintypes.UINT()
    if not version.VerQueryValueW(buf, "\\", ctypes.byref(ptr), ctypes.byref(length)) or not ptr.value:
        return None
    # VS_FIXEDFILEINFO: dwSignature, dwStrucVersion, dwFileVersionMS, dwFileVersionLS, ...
    fields = ctypes.cast(ptr, ctypes.POINTER(wintypes.DWORD * 4)).contents
    ms, ls = fields[2], fields[3]
    return (ms >> 16, ms & 0xFFFF, ls >> 16, ls & 0xFFFF)


def _preload_newest_msvcp140() -> None:
    import ctypes

    system_root = Path(os.environ.get("SystemRoot") or r"C:\Windows")
    candidates = [
        BUNDLED_VCREDIST_DIR / "msvcp140.dll",
        system_root / "System32" / "msvcp140.dll",
        Path(sys.executable).parent / "msvcp140.dll",
        Path(sys.base_prefix) / "msvcp140.dll",
    ]
    best: tuple[tuple[int, int, int, int], Path] | None = None
    for candidate in candidates:
        try:
            if not candidate.is_file():
                continue
            found = _dll_file_version(candidate)
        except OSError:
            continue
        if found and (best is None or found > best[0]):
            best = (found, candidate)
    if best is None:
        return
    found, path = best
    try:
        ctypes.WinDLL(str(path))
    except OSError:
        return
    if found[:2] < _MIN_MSVCP140_VERSION:
        print(
            f"[runtime] 警告：可用的 msvcp140.dll 最高仅 {'.'.join(map(str, found))}"
            f"（{path}），onnxruntime/Whisper 可能崩溃。请安装最新 VC++ 2015-2022 运行库。",
            flush=True,
        )


def _exe(name: str) -> str:
    return f"{name}.exe" if os.name == "nt" else name


def find_ffmpeg() -> str:
    configured = str(os.environ.get("FFMPEG_PATH") or "").strip()
    if configured and Path(configured).exists():
        return configured
    bundled = BUNDLED_FFMPEG_DIR / _exe("ffmpeg")
    if bundled.exists():
        return str(bundled)
    found = shutil.which("ffmpeg")
    if found:
        return found
    conda_root = Path(sys.executable).parent
    for candidate in (conda_root / _exe("ffmpeg"), conda_root / "Library" / "bin" / _exe("ffmpeg")):
        if candidate.exists():
            return str(candidate)
    raise FileNotFoundError("ffmpeg not found. Install ffmpeg or use the Release bundle.")


def find_ffprobe() -> str:
    found = shutil.which("ffprobe")
    if found:
        return found
    candidate = Path(find_ffmpeg()).with_name(_exe("ffprobe"))
    if candidate.exists():
        return str(candidate)
    raise FileNotFoundError("ffprobe not found. Install ffmpeg/ffprobe first.")


def find_ffmpeg_dir() -> str | None:
    """返回包含 ffmpeg 的目录，供 yt-dlp 的 ffmpeg_location 使用；找不到返回 None。"""
    try:
        return str(Path(find_ffmpeg()).parent)
    except FileNotFoundError:
        return None
