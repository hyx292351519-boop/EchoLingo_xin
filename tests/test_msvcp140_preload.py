"""Regression: an old msvcp140.dll next to python.exe (Anaconda ships 14.27) made
`import onnxruntime` crash the whole server with 0xc0000005 mid-job, which the
browser surfaced as "Failed to fetch"."""
import importlib.util
import os
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1] / "backend"

pytestmark = pytest.mark.skipif(os.name != "nt", reason="Windows DLL loading only")


def test_lfs_pointer_is_not_treated_as_dll(tmp_path):
    sys.path.insert(0, str(BACKEND))
    from sources.media_bins import _dll_file_version

    fake = tmp_path / "msvcp140.dll"
    fake.write_text("version https://git-lfs.github.com/spec/v1\n")
    assert _dll_file_version(fake) is None


def test_onnxruntime_imports_after_runtime_preload():
    # 不能 importorskip：在未预加载的 pytest 进程里 import 本身就会崩溃
    if importlib.util.find_spec("onnxruntime") is None:
        pytest.skip("onnxruntime not installed")
    code = (
        "from sources.media_bins import enable_bundled_runtime\n"
        "enable_bundled_runtime()\n"
        "import onnxruntime\n"
        "print('ok')\n"
    )
    result = subprocess.run([sys.executable, "-c", code], cwd=BACKEND,
                            capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stderr
    assert "ok" in result.stdout


def test_lfs_pointer_dll_directory_detected(tmp_path):
    sys.path.insert(0, str(BACKEND))
    from sources.media_bins import _has_lfs_pointer_dll

    (tmp_path / "msvcp140_1.dll").write_text("version https://git-lfs.github.com/spec/v1\n")
    assert _has_lfs_pointer_dll(tmp_path)
    real = tmp_path / "real"
    real.mkdir()
    (real / "x.dll").write_bytes(b"MZ" + b"\0" * 2048)
    assert not _has_lfs_pointer_dll(real)
