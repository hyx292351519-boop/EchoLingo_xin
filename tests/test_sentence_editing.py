import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from fastapi.testclient import TestClient


def _client(tmp_path, monkeypatch, name="edit.db"):
    import db
    from fastapi_server import create_app

    monkeypatch.setattr(db, "DB_PATH", tmp_path / name)
    return db, TestClient(create_app())


def _units(client, lesson_id):
    data = client.get(f"/api/v2/lessons/{lesson_id}/subtitles").json()
    return data["sentence_units"]


def _edit(client, lesson_id, **body):
    return client.post(f"/api/v2/lessons/{lesson_id}/sentences/edit", json=body)


# ── splitter rules ────────────────────────────────────────────────────────


def test_splitter_keeps_abbreviations_and_spaced_decimals_together():
    from analyzer import SentenceAnalyzer

    split = SentenceAnalyzer._split_text_sentences
    assert split("See Fig. 6 for details. It helps.") == ["See Fig. 6 for details.", "It helps."]
    assert split("Dr. Smith agreed. We left.") == ["Dr. Smith agreed.", "We left."]
    assert split("The U.S. economy grew. It grew 2. 5 percent.") == [
        "The U.S. economy grew.", "It grew 2. 5 percent.",
    ]
    assert split("Rates rose 3.5 percent. Then they fell.") == ["Rates rose 3.5 percent.", "Then they fell."]
    # 真正的句末不受影响
    assert split("We moved to the U.S. Then we left.") == ["We moved to the U.S.", "Then we left."]
    assert split("I said no. Okay.") == ["I said no.", "Okay."]

    # 大写断句（ASR 丢标点修复）也不能在大写缩写前切开并补句点
    from webapp.services.v2_tts import _synthesizable_sentences

    assert _synthesizable_sentences(
        "The text says DP-Post spillage is 8%, but Fig. 6 shows 17%. So we checked again."
    ) == ["The text says DP-Post spillage is 8%, but Fig. 6 shows 17%.", "So we checked again."]


def test_word_timestamp_split_respects_abbreviations():
    from webapp.services.v2_translation import build_translation_units

    words = [
        {"text": "See", "punctuation": " ", "start": 0.0, "end": 0.3},
        {"text": "Fig", "punctuation": ". ", "start": 0.3, "end": 0.6},
        {"text": "6", "punctuation": " ", "start": 0.6, "end": 0.8},
        {"text": "now", "punctuation": ". ", "start": 0.8, "end": 1.0},
        {"text": "Good", "punctuation": ".", "start": 1.2, "end": 1.5},
    ]
    units = build_translation_units(
        [{"index": 0, "start": 0, "end": 1.5, "text": "See Fig. 6 now. Good.", "words": words}]
    )
    assert [unit["text"] for unit in units] == ["See Fig. 6 now.", "Good."]


# ── media lessons ─────────────────────────────────────────────────────────


def _media_lesson(db):
    lesson = db.create_v2_lesson(
        source_type="youtube",
        source_url="https://www.youtube.com/watch?v=abc123def45",
        video_id="abc123def45",
        title="Demo",
    )
    db.replace_v2_subtitle_segments(lesson["id"], [
        {"index": 0, "start": 0.0, "end": 2.0, "text": "The rate was 3."},
        {"index": 1, "start": 2.0, "end": 4.0, "text": "And it kept going up."},
        {"index": 2, "start": 5.0, "end": 8.0, "text": "We were surprised. Nobody expected it."},
    ])
    return lesson


def test_media_merge_split_edit_and_delete(tmp_path, monkeypatch):
    db, client = _client(tmp_path, monkeypatch)
    lesson = _media_lesson(db)
    lesson_id = lesson["id"]
    before = [unit["text"] for unit in _units(client, lesson_id)]
    assert before == [
        "The rate was 3.", "And it kept going up.", "We were surprised.", "Nobody expected it.",
    ]

    resp = _edit(client, lesson_id, action="merge_next", unit_index=0, original_text=before[0])
    assert resp.status_code == 200, resp.text
    # 只有被改动的句子需要补译，不会把整课没翻译的句子都重新翻一遍
    assert resp.json()["translation_pending"] == 0  # 课程未开启翻译
    units = _units(client, lesson_id)
    assert [unit["text"] for unit in units][:2] == ["The rate was 3. And it kept going up.", "We were surprised."]
    assert units[0]["start"] == 0.0 and units[0]["end"] == 4.0

    # 文字修正 + 回车拆句（texts 多于一项）
    resp = _edit(
        client, lesson_id, action="replace", unit_index=0,
        original_text="The rate was 3. And it kept going up.",
        texts=["The rate was 3.5,", "and it kept going up."],
    )
    assert resp.status_code == 200, resp.text
    units = _units(client, lesson_id)
    assert [unit["text"] for unit in units] == [
        "The rate was 3.5,", "and it kept going up.", "We were surprised.", "Nobody expected it.",
    ]
    assert 0.0 < units[0]["end"] == units[1]["start"] < 4.0

    # 手动句不再被自动重切/合并（"3.5," 无句末标点，自动规则本会与下一句合并）
    segments = db.get_v2_subtitle_segments(lesson_id)
    assert all(segment.get("manual") for segment in segments)

    resp = _edit(client, lesson_id, action="delete", unit_index=3, original_text="Nobody expected it.")
    assert resp.status_code == 200
    assert [unit["text"] for unit in _units(client, lesson_id)][-1] == "We were surprised."

    # 阅读视图与精读页使用同一套句子
    reading = client.get(f"/api/v2/lessons/{lesson_id}/reading").json()
    reading_texts = [s["text"] for block in reading["blocks"] for s in block["sentences"]]
    assert reading_texts == ["The rate was 3.5,", "and it kept going up.", "We were surprised."]
    intensive = client.get(f"/api/v2/lessons/{lesson_id}/intensive").json()
    assert [s["text"] for s in intensive["sentences"]] == reading_texts


def test_media_edit_rejects_stale_and_invalid_requests(tmp_path, monkeypatch):
    db, client = _client(tmp_path, monkeypatch, "edit-stale.db")
    lesson_id = _media_lesson(db)["id"]

    stale = _edit(client, lesson_id, action="replace", unit_index=0, original_text="Something else.", texts=["x y"])
    assert stale.status_code == 409
    last = _edit(client, lesson_id, action="merge_next", unit_index=3, original_text="Nobody expected it.")
    assert last.status_code == 400
    first = _edit(client, lesson_id, action="merge_prev", unit_index=0, original_text="The rate was 3.")
    assert first.status_code == 400
    empty = _edit(client, lesson_id, action="replace", unit_index=0, original_text="The rate was 3.", texts=["  "])
    assert empty.status_code == 400
    # 失败的请求不改动课程
    assert not any(segment.get("manual") for segment in db.get_v2_subtitle_segments(lesson_id))


# ── reading lessons ───────────────────────────────────────────────────────


def _reading_lesson(db, **extra):
    lesson = db.create_v2_lesson(
        source_type="reading_text",
        source_url="manual:edit-demo",
        title="Edit Demo",
        lesson_mode="reading",
        **extra,
    )
    db.replace_v2_reading_blocks(lesson["id"], [
        {"index": 1, "text": "The total was 12. 5 million. That is large."},
        {"index": 2, "text": "Costs rose. They fell again."},
    ])
    return lesson


def _intensive_texts(client, lesson_id):
    return [s["text"] for s in client.get(f"/api/v2/lessons/{lesson_id}/intensive").json()["sentences"]]


def test_reading_split_merge_across_paragraphs_and_edit(tmp_path, monkeypatch):
    db, client = _client(tmp_path, monkeypatch, "edit-reading.db")
    lesson_id = _reading_lesson(db)["id"]
    assert _intensive_texts(client, lesson_id) == [
        "The total was 12. 5 million.", "That is large.", "Costs rose.", "They fell again.",
    ]

    resp = _edit(
        client, lesson_id, action="replace", block_index=1, sentence_index=0,
        original_text="The total was 12. 5 million.", texts=["The total was 12.5 million."],
    )
    assert resp.status_code == 200, resp.text
    resp = _edit(
        client, lesson_id, action="merge_next", block_index=1, sentence_index=1,
        original_text="That is large.",
    )
    assert resp.status_code == 200, resp.text
    assert _intensive_texts(client, lesson_id) == [
        "The total was 12.5 million.", "That is large. Costs rose.", "They fell again.",
    ]
    blocks = db.get_v2_reading_blocks(lesson_id)
    assert blocks[0]["manual_sentences"] == ["The total was 12.5 million.", "That is large. Costs rose."]
    assert blocks[0]["text"] == "The total was 12.5 million. That is large. Costs rose."
    assert blocks[1]["text"] == "They fell again."

    # 工作区阅读视图拿到的是同一套句子（不再由前端自行切句）
    reading = client.get(f"/api/v2/lessons/{lesson_id}/reading").json()
    assert [s["text"] for b in reading["blocks"] for s in b["sentences"]] == _intensive_texts(client, lesson_id)

    # 整段并入上一段后，空段落被移除
    resp = _edit(
        client, lesson_id, action="merge_prev", block_index=2, sentence_index=0,
        original_text="They fell again.",
    )
    assert resp.status_code == 200, resp.text
    blocks = db.get_v2_reading_blocks(lesson_id)
    assert len(blocks) == 1
    assert blocks[0]["manual_sentences"][-1] == "That is large. Costs rose. They fell again."


def test_reading_with_generated_audio_keeps_segments_in_step(tmp_path, monkeypatch):
    db, client = _client(tmp_path, monkeypatch, "edit-audio.db")
    lesson = _reading_lesson(db, media_url="/media/reading.wav", media_kind="generated_audio")
    lesson_id = lesson["id"]
    # TTS 按旧断句逐句合成的音频段
    db.replace_v2_subtitle_segments(lesson_id, [
        {"index": 0, "start": 0.0, "end": 1.0, "text": "The total was 12."},
        {"index": 1, "start": 1.0, "end": 2.0, "text": "5 million."},
        {"index": 2, "start": 2.0, "end": 3.0, "text": "That is large."},
        {"index": 3, "start": 3.5, "end": 4.5, "text": "Costs rose."},
        {"index": 4, "start": 4.5, "end": 5.5, "text": "They fell again."},
    ])
    texts = _intensive_texts(client, lesson_id)
    client.get(f"/api/v2/lessons/{lesson_id}/reading")
    texts = _intensive_texts(client, lesson_id)
    assert texts[:2] == ["The total was 12.", "5 million."]

    resp = _edit(client, lesson_id, action="merge_next", block_index=1, sentence_index=0, original_text=texts[0])
    assert resp.status_code == 200, resp.text
    segments = db.get_v2_subtitle_segments(lesson_id)
    assert [s["text"] for s in segments] == [
        "The total was 12. 5 million.", "That is large.", "Costs rose.", "They fell again.",
    ]
    assert segments[0]["start"] == 0.0 and segments[0]["end"] == 2.0
    assert all(s.get("manual") for s in segments)
    # 第二段的时间轴没有错位
    sentences = client.get(f"/api/v2/lessons/{lesson_id}/intensive").json()["sentences"]
    by_text = {s["text"]: s for s in sentences}
    assert by_text["Costs rose."]["start_seconds"] == 3.5
    # 听力模式句单元与阅读句一一对应
    assert [u["text"] for u in _units(client, lesson_id)] == [s["text"] for s in sentences]


def test_backfill_translates_only_changed_sentences(tmp_path, monkeypatch):
    db, client = _client(tmp_path, monkeypatch, "edit-backfill.db")
    lesson_id = _media_lesson(db)["id"]
    db.configure_v2_lesson_translation(lesson_id, requested=True)
    import webapp.fastapi_routes.v2_lessons as routes

    spawned = []
    monkeypatch.setattr(routes.db, "spawn_with_db_context", lambda fn, *args, **kw: spawned.append(args))
    resp = _edit(
        client, lesson_id, action="replace", unit_index=1,
        original_text="And it kept going up.", texts=["And it kept going up fast."],
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["translation_pending"] == 1
    assert spawned == [(lesson_id, ["And it kept going up fast."])]
