import json
from types import SimpleNamespace

from fastapi.testclient import TestClient


def _setup(tmp_path, monkeypatch, words=("leverage", "concept")):
    import db
    from fastapi_server import create_app

    monkeypatch.setattr(db, "DB_PATH", tmp_path / "vocab.db")
    db.init_db()
    for word in words:
        db.activate_word_review(word, source="manual", analysis={
            "basic_meaning": f"{word} 的意思",
            "concept": {"core_en": f"core of {word}"},
            "collocation_groups": [{"category": "verb", "items": [{"phrase": f"use {word}"}]}],
            "sentence_building": {"common_errors": [{"wrong": "x on", "right": "x"}]},
        })
    return db, TestClient(create_app())


def _fake_client(payload, calls):
    def create(**kwargs):
        calls.append(kwargs)
        message = SimpleNamespace(content=json.dumps(payload, ensure_ascii=False))
        return SimpleNamespace(choices=[SimpleNamespace(message=message, finish_reason="stop")])

    return SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))


def test_results_update_familiarity_schedule_and_can_be_undone(tmp_path, monkeypatch):
    db, client = _setup(tmp_path, monkeypatch)
    db.set_next_review("concept", "2030-01-01")

    changes = db.record_recall_results(
        [{"word": "leverage", "result": "correct"}, {"word": "concept", "result": "incorrect"},
         {"word": "missing", "result": "correct"}, {"word": "leverage", "result": "bogus"}],
        today="2026-11-20",
    )
    by_word = {c["word"]: c for c in changes}
    assert set(by_word) == {"leverage", "concept"}
    assert by_word["leverage"]["current"] == {"familiarity": "known", "next_review": "2026-11-23", "interval_days": 3}
    assert by_word["concept"]["current"]["familiarity"] == "unknown"
    assert by_word["concept"]["current"]["next_review"] == "2026-11-21"
    assert by_word["concept"]["previous"] == {"familiarity": "unrated", "next_review": "2030-01-01"}

    # A second correct answer in a row lengthens the interval
    again = db.record_recall_results([{"word": "leverage", "result": "correct"}], today="2026-11-23")
    assert again[0]["current"]["interval_days"] == 7

    last = client.get("/api/recall-test/last-results").json()["results"]
    assert last["concept"]["result"] == "incorrect"

    undo = client.post("/api/recall-test/undo", json={"word": "concept", "familiarity": "unrated", "next_review": "2030-01-01"})
    assert undo.status_code == 200
    item = client.get("/vocab-log").json()["concept"]
    assert item["familiarity"] == "unrated"
    assert item["next_review"] == "2030-01-01"
    assert "concept" not in client.get("/api/recall-test/last-results").json()["results"]

    assert client.post("/api/recall-test/undo", json={"word": "concept", "familiarity": "great"}).status_code == 400


def test_results_endpoint(tmp_path, monkeypatch):
    _, client = _setup(tmp_path, monkeypatch)
    response = client.post("/api/recall-test/results", json={"results": [{"word": "leverage", "result": "partial"}]})
    assert response.status_code == 200
    change = response.json()["changes"][0]
    assert change["current"]["familiarity"] == "fuzzy"
    assert change["current"]["interval_days"] == 1


def test_ai_questions_use_learning_points_and_filter_bad_items(tmp_path, monkeypatch):
    _, client = _setup(tmp_path, monkeypatch)
    from webapp.fastapi_routes import recall_test

    calls = []
    payload = {"questions": [
        {"word": "leverage", "type": "scene", "question": "开会时你想说要充分利用现有数据", "answer": "We should leverage our data."},
        {"word": "leverage", "type": "scene", "question": "重复题", "answer": "x"},
        {"word": "unrelated", "type": "scene", "question": "不在列表里", "answer": "x"},
        {"word": "concept", "type": "weird", "question": "翻译：这个思路很好", "answer": "It's a good concept."},
    ]}
    monkeypatch.setattr(recall_test.ai_config, "client", _fake_client(payload, calls))

    response = client.post("/api/recall-test/ai-questions", json={"words": ["Leverage", "concept", "leverage"]})
    assert response.status_code == 200
    questions = response.json()["questions"]
    assert [q["word"] for q in questions] == ["leverage", "concept"]
    assert questions[1]["type"] == "translate"
    prompt = calls[0]["messages"][0]["content"]
    assert "use leverage" in prompt and "core of concept" in prompt

    assert client.post("/api/recall-test/ai-questions", json={"words": []}).status_code == 400


def test_home_page_exposes_recall_test(tmp_path, monkeypatch):
    _, client = _setup(tmp_path, monkeypatch, words=())
    page = client.get("/").text
    assert "setWorkshopView('recall')" in page
    assert 'id="recall-test-root"' in page
    assert "/static/recall-test.js" in page
    assert client.get("/static/recall-test.js").status_code == 200
