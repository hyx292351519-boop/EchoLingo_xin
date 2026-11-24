"""精读 → 返回课程：回到对应句子的视频位置；视频可拖动进度条；断点续播。"""
from pathlib import Path

TEMPLATES = Path(__file__).parents[1] / "frontend" / "templates"
WORKSPACE = (TEMPLATES / "workspace.html").read_text(encoding="utf-8-sig")
INTENSIVE = (TEMPLATES / "intensive.html").read_text(encoding="utf-8-sig")


def test_intensive_back_link_carries_sentence_position():
    assert 'id="back-to-lesson"' in INTENSIVE
    assert "function lessonReturnUrl()" in INTENSIVE
    body = INTENSIVE.split("function lessonReturnUrl()", 1)[1].split("\n    }\n", 1)[0]
    assert "params.set('t'" in body and "sentence_key" in body


def test_workspace_resumes_from_return_param_or_saved_progress():
    assert "await prepareResumePosition();" in WORKSPACE
    body = WORKSPACE.split("async function prepareResumePosition()", 1)[1].split("\n}\n", 1)[0]
    assert "returnParams.get('t')" in body
    assert "/progress`" in body
    # YouTube 播放器以续播点作为起点，未开始播放前不得把当前句重置回第一句
    assert "playerVars.start = Math.floor(pendingResumeSeconds)" in WORKSPACE
    assert "getPlayerState() === 1" in WORKSPACE


def test_workspace_has_draggable_progress_bar_and_saves_progress():
    assert 'id="media-progress-range"' in WORKSPACE
    assert "initMediaProgressBar();" in WORKSPACE
    assert "initProgressSaving();" in WORKSPACE
    assert "navigator.sendBeacon" in WORKSPACE
