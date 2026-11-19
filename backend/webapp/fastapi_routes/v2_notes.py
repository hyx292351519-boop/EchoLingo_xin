"""Learning notes: per-sentence and per-lesson notes with tags."""
from __future__ import annotations

from typing import Optional, Union

import db
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/api/v2/notes")

TagsInput = Optional[Union[list[str], str]]


class NoteCreate(BaseModel):
    lesson_id: int
    content: str
    sentence_key: Optional[int] = None
    sentence_text: str = ""
    tags: TagsInput = None


class NoteUpdate(BaseModel):
    content: Optional[str] = None
    tags: TagsInput = None


@router.get("")
def list_notes(
    lesson_id: Optional[int] = None,
    scope: str = "",
    q: str = "",
    tag: str = "",
    limit: int = 500,
):
    if scope not in {"", "lesson", "sentence"}:
        raise HTTPException(status_code=400, detail="invalid scope")
    notes = db.list_v2_notes(lesson_id=lesson_id, scope=scope, query=q, tag=tag, limit=limit)
    return {"notes": notes, "total": len(notes)}


@router.get("/tags")
def list_note_tags():
    return {"tags": db.list_v2_note_tags()}


@router.post("")
def create_note(body: NoteCreate):
    try:
        note = db.create_v2_note(
            body.lesson_id,
            body.content,
            sentence_key=body.sentence_key,
            sentence_text=body.sentence_text,
            tags=body.tags,
        )
    except ValueError as exc:
        status = 404 if str(exc) == "Lesson not found" else 400
        raise HTTPException(status_code=status, detail=str(exc)) from exc
    return {"note": note}


@router.patch("/{note_id}")
def update_note(note_id: int, body: NoteUpdate):
    try:
        note = db.update_v2_note(note_id, content=body.content, tags=body.tags)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    return {"note": note}


@router.delete("/{note_id}")
def delete_note(note_id: int):
    if not db.delete_v2_note(note_id):
        raise HTTPException(status_code=404, detail="Note not found")
    return {"ok": True}
