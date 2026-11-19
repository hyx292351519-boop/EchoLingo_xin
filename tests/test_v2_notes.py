from fastapi.testclient import TestClient


def _client_and_lesson(tmp_path, monkeypatch, title="Notes Lesson"):
    import db
    from fastapi_server import create_app

    monkeypatch.setattr(db, "DB_PATH", tmp_path / "vocab.db")
    lesson = db.create_v2_lesson(
        source_type="reading_text",
        source_url=f"manual:{title}",
        title=title,
        lesson_mode="reading",
    )
    return TestClient(create_app()), lesson


def test_sentence_and_lesson_notes_crud(tmp_path, monkeypatch):
    client, lesson = _client_and_lesson(tmp_path, monkeypatch)

    sentence_note = client.post("/api/v2/notes", json={
        "lesson_id": lesson["id"],
        "sentence_key": -10001,
        "sentence_text": "  I've been   meaning to call you. ",
        "content": "been meaning to = 一直想做却没做\n带点愧疚感",
        "tags": ["表达", "#表达", " 易错 "],
    })
    assert sentence_note.status_code == 200
    note = sentence_note.json()["note"]
    assert note["scope"] == "sentence"
    assert note["sentence_text"] == "I've been meaning to call you."
    assert note["tags"] == ["表达", "易错"]
    assert note["lesson_title"] == "Notes Lesson"

    lesson_note = client.post("/api/v2/notes", json={
        "lesson_id": lesson["id"],
        "content": "这节课主要讲拖延的表达。",
        "tags": "总结，复习",
    }).json()["note"]
    assert lesson_note["scope"] == "lesson"
    assert lesson_note["sentence_key"] is None
    assert lesson_note["tags"] == ["总结", "复习"]

    listed = client.get("/api/v2/notes", params={"lesson_id": lesson["id"]}).json()
    assert listed["total"] == 2
    assert client.get("/api/v2/notes", params={"scope": "lesson"}).json()["total"] == 1
    assert client.get("/api/v2/notes", params={"q": "meaning"}).json()["total"] == 1
    assert client.get("/api/v2/notes", params={"q": "Notes Lesson"}).json()["total"] == 2
    assert client.get("/api/v2/notes", params={"q": "100%"}).json()["total"] == 0
    assert client.get("/api/v2/notes", params={"tag": "易错"}).json()["total"] == 1

    tags = client.get("/api/v2/notes/tags").json()["tags"]
    assert {"name": "表达", "count": 1} in tags

    updated = client.patch(f"/api/v2/notes/{note['id']}", json={"content": "改过的内容", "tags": []})
    assert updated.status_code == 200
    assert updated.json()["note"]["content"] == "改过的内容"
    assert updated.json()["note"]["tags"] == []

    assert client.delete(f"/api/v2/notes/{note['id']}").status_code == 200
    assert client.delete(f"/api/v2/notes/{note['id']}").status_code == 404
    assert client.get("/api/v2/notes").json()["total"] == 1


def test_note_validation(tmp_path, monkeypatch):
    client, lesson = _client_and_lesson(tmp_path, monkeypatch)

    assert client.post("/api/v2/notes", json={"lesson_id": lesson["id"], "content": "   "}).status_code == 400
    assert client.post("/api/v2/notes", json={"lesson_id": 99999, "content": "x"}).status_code == 404
    missing_text = client.post("/api/v2/notes", json={
        "lesson_id": lesson["id"], "sentence_key": 3, "content": "x",
    })
    assert missing_text.status_code == 400
    assert client.patch("/api/v2/notes/12345", json={"content": "x"}).status_code == 404
    assert client.get("/api/v2/notes", params={"scope": "bogus"}).status_code == 400


def test_notes_survive_lesson_deletion(tmp_path, monkeypatch):
    import db

    client, lesson = _client_and_lesson(tmp_path, monkeypatch, title="Deleted Lesson")
    client.post("/api/v2/notes", json={"lesson_id": lesson["id"], "content": "保留我"})
    with db._db() as conn:
        conn.execute("DELETE FROM v2_lessons WHERE id=?", (lesson["id"],))

    notes = client.get("/api/v2/notes").json()["notes"]
    assert len(notes) == 1
    assert notes[0]["lesson_id"] is None
    assert notes[0]["lesson_exists"] is False
    assert notes[0]["lesson_title"] == "Deleted Lesson"


def test_pages_expose_notes_entry_points(tmp_path, monkeypatch):
    client, lesson = _client_and_lesson(tmp_path, monkeypatch)

    home = client.get("/").text
    assert 'id="tab-notes"' in home
    assert "switchTab('notes')" in home
    assert "/api/v2/notes?limit=2000" in home

    workspace = client.get(f"/workspace/{lesson['id']}").text
    assert 'data-sidebar-target="notes"' in workspace
    assert "runReadingSelectionAction('note')" in workspace
    assert "'notes']" in workspace

    intensive = client.get(f"/workspace/{lesson['id']}/intensive").text
    assert 'data-v1-module="notes"' in intensive
    assert "/api/v2/notes?lesson_id=" in intensive
