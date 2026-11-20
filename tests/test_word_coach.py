import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient


def _coach_payload(**overrides):
    payload = {
        "word": "concept",
        "basic_meaning": "概念；观念",
        "contextual_meaning": "这里指产品的整体设想。",
        "recognition": {
            "morphology": {
                "splittable": True,
                "parts": [
                    {"part": "con-", "type": "prefix", "meaning": "together"},
                    {"part": "cept", "type": "root", "meaning": "take"},
                    {"part": "???", "type": "bogus", "meaning": "x"},
                ],
                "explanation": "把东西放在一起抓住，形成一个想法。",
                "etymology": "Latin conceptum.",
            },
            "pronunciation": {
                "ipa_us": "/ˈkɑːn.sept/", "ipa_uk": "/ˈkɒn.sept/", "syllables": "con·cept",
                "stress": "重音在第一个音节。",
                "spelling_to_sound": [{"letters": "c", "sound": "/k/", "note": "常见"}],
                "irregular": "", "pitfalls": "不要把 cept 读成 /kept/。",
            },
        },
        "concept": {
            "core_en": "An idea of what something is or how it works.",
            "core_cn": "对某事物是什么、怎么运作的整体想法。",
            "mental_picture": "脑子里的一张蓝图。",
            "senses": [{"pos": "noun", "sense_en": "an abstract idea", "sense_cn": "概念", "link": "核心义"}],
            "usage": {"daily": "d", "work_academic": "w", "most_natural": "m", "prefer_others": "p"},
        },
        "collocation_groups": [
            {"category": "verb", "items": [
                {"phrase": "grasp the concept", "en": "understand it", "cn": "理解概念", "example": "e1"},
            ]},
            {"category": "weird", "items": [{"phrase": "concept car", "cn": "概念车"}]},
            {"category": "noun", "items": []},
        ],
        "sentence_building": {
            "forms": "名词，复数 concepts。",
            "patterns": [{"pattern": "the concept of sth", "note": "后接 of", "example": "x"}],
            "common_errors": [{"wrong": "a concept about", "right": "a concept of", "why": "介词搭配"}],
            "examples": [
                {"scene": "daily", "en": "I get the concept.", "cn": "我明白这个意思。"},
                {"scene": "work", "en": "Let's test the concept first.", "cn": "先验证一下这个思路。"},
            ],
        },
        "similar_words": [{"word": "idea", "core": "idea 更宽泛", "usage": "u", "collocation": "c", "not_interchangeable": "n"}],
        "exercises": [
            {"type": "choose", "question": "选出更自然的说法", "options": ["a", "b"], "answer": "a", "explanation": "x"},
            {"type": "translate", "question": "翻译：先验证思路", "options": ["ignored"], "answer": "test the concept", "explanation": "y"},
        ],
    }
    payload.update(overrides)
    return payload


def test_normalize_word_coach_cleans_structure_and_derives_legacy_fields():
    from webapp.services.word_coach import normalize_word_coach

    result = normalize_word_coach(_coach_payload(), "concept")

    assert result["schema"] == "word_coach_v1"
    parts = result["recognition"]["morphology"]["parts"]
    assert [p["type"] for p in parts] == ["prefix", "root", "root"]
    assert [g["category"] for g in result["collocation_groups"]] == ["verb", "phrase"]
    assert result["exercises"][1]["options"] == []
    # legacy flat fields keep older views working
    assert result["basic_meaning"] == "概念；观念"
    assert result["ipa"] == "/ˈkɑːn.sept/"
    assert result["pos"] == "noun"
    assert result["en_definition"].startswith("An idea")
    assert result["collocations"][0] == "grasp the concept（理解概念）"
    assert result["synonyms"] == [{"word": "idea", "difference": "idea 更宽泛"}]
    assert result["examples"] == ["I get the concept.", "Let's test the concept first."]


def test_normalize_word_coach_rejects_missing_concept():
    from webapp.services.word_coach import normalize_word_coach

    with pytest.raises(ValueError):
        normalize_word_coach({"word": "x", "concept": {}}, "x")


def _fake_client(payload, calls):
    def create(**kwargs):
        calls.append(kwargs)
        message = SimpleNamespace(content=json.dumps(payload, ensure_ascii=False))
        return SimpleNamespace(choices=[SimpleNamespace(message=message, finish_reason="stop")])

    return SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))


def test_analyze_word_uses_coach_prompt_and_replaces_legacy_cache(tmp_path, monkeypatch):
    import db
    from fastapi_server import create_app
    from webapp.fastapi_routes import ai

    monkeypatch.setattr(db, "DB_PATH", tmp_path / "vocab.db")
    db.upsert_word("concept", "2026-11-20", analysis={"basic_meaning": "旧", "ielts_note": "旧考点", "register": "formal"})
    calls = []
    monkeypatch.setattr(ai.ai_config, "client", _fake_client(_coach_payload(), calls))
    monkeypatch.setattr(ai.ai_config, "AI_BASE_URL", "https://api.deepseek.com")
    monkeypatch.setattr(ai.ai_config, "AI_MODEL", "deepseek-v4-flash")

    response = TestClient(create_app()).post(
        "/analyze-word", json={"word": "concept", "sentence": "We like the concept."}
    )

    assert response.status_code == 200
    data = response.json()
    assert data["schema"] == "word_coach_v1"
    assert "ielts_note" not in data and "register" not in data
    prompt = calls[0]["messages"][0]["content"]
    assert "Mental" not in prompt and "mental_picture" in prompt
    assert "We like the concept." in prompt
    assert calls[0]["extra_body"] == {"thinking": {"type": "disabled"}}
    stored = db.get_cached_word_analysis("concept")
    assert stored["schema"] == "word_coach_v1"
    assert stored["basic_meaning"] == "概念；观念"


def test_word_exercise_check(monkeypatch):
    from fastapi_server import create_app
    from webapp.fastapi_routes import ai

    calls = []
    payload = {"verdict": "Partial", "feedback": "介词用错了。", "corrected": "the concept of", "better_expression": ""}
    monkeypatch.setattr(ai.ai_config, "client", _fake_client(payload, calls))
    client = TestClient(create_app())

    ok = client.post("/api/word-exercise-check", json={
        "word": "concept", "type": "translate", "question": "翻译", "answer": "the concept of",
        "user_answer": "the concept about",
    })
    assert ok.status_code == 200
    assert ok.json()["verdict"] == "partial"
    assert "the concept about" in calls[0]["messages"][0]["content"]

    empty = client.post("/api/word-exercise-check", json={"word": "concept", "question": "q", "user_answer": " "})
    assert empty.status_code == 400


def test_edited_word_analysis_is_saved_and_cleared_by_regeneration(tmp_path, monkeypatch):
    import db
    from fastapi_server import create_app
    from webapp.fastapi_routes import ai
    from webapp.services.word_coach import normalize_word_coach

    monkeypatch.setattr(db, "DB_PATH", tmp_path / "vocab.db")
    monkeypatch.setattr(ai.ai_config, "client", _fake_client(_coach_payload(), []))
    client = TestClient(create_app())

    original = normalize_word_coach(_coach_payload(), "concept")
    original["concept"]["mental_picture"] = "我自己的画面"
    original["basic_meaning"] = "构想"

    missing = client.post("/api/word-analysis/save", json={"word": "concept", "analysis": original})
    assert missing.status_code == 404

    db.upsert_word("concept", "2026-11-20", analysis={"basic_meaning": "旧"})
    saved = client.post("/api/word-analysis/save", json={"word": "concept", "analysis": original})
    assert saved.status_code == 200
    assert saved.json()["edited"] is True
    stored = db.get_cached_word_analysis("concept")
    assert stored["concept"]["mental_picture"] == "我自己的画面"
    assert stored["basic_meaning"] == "构想"

    legacy = client.post("/api/word-analysis/save", json={"word": "concept", "analysis": {"basic_meaning": "x"}})
    assert legacy.status_code == 400

    client.post("/analyze-word", json={"word": "concept", "sentence": ""})
    assert "edited" not in db.get_cached_word_analysis("concept")


def test_pages_load_analysis_editor():
    from fastapi_server import create_app

    client = TestClient(create_app())
    assert "/static/analysis-editor.js" in client.get("/").text
    assert client.get("/static/analysis-editor.js").status_code == 200
    assert client.get("/static/word-coach.js").status_code == 200
