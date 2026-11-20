"""Active-recall tests over words the learner has studied."""
from __future__ import annotations

import json
from typing import List, Optional

import db
from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from prompts import RECALL_QUESTIONS_PROMPT
from starlette.concurrency import run_in_threadpool
from webapp.runtime import ai_config
from webapp.services.ai_json import json_completion_kwargs, parse_ai_json

router = APIRouter(prefix="/api/recall-test")

AI_QUESTION_LIMIT = 10
QUESTION_TYPES = ("scene", "translate", "collocation")


class AiQuestionsBody(BaseModel):
    words: List[str]


class RecallResult(BaseModel):
    word: str
    result: str


class ResultsBody(BaseModel):
    results: List[RecallResult]


class UndoBody(BaseModel):
    word: str
    familiarity: str
    next_review: Optional[str] = ""


def _s(value) -> str:
    return " ".join(str(value or "").split())


def _word_summary(word: str, analysis: dict | None) -> dict:
    """Compact learning points for the question prompt."""
    analysis = analysis if isinstance(analysis, dict) else {}
    concept = analysis.get("concept") if isinstance(analysis.get("concept"), dict) else {}
    building = analysis.get("sentence_building") if isinstance(analysis.get("sentence_building"), dict) else {}
    collocations = []
    for group in analysis.get("collocation_groups") or []:
        for item in (group or {}).get("items") or []:
            if isinstance(item, dict) and item.get("phrase"):
                collocations.append(_s(item["phrase"]))
    if not collocations:
        collocations = [_s(item) for item in analysis.get("collocations") or [] if isinstance(item, str)]
    errors = [
        f"{_s(item.get('wrong'))} → {_s(item.get('right'))}"
        for item in building.get("common_errors") or [] if isinstance(item, dict) and item.get("right")
    ]
    return {
        "word": word,
        "meaning": _s(analysis.get("basic_meaning")),
        "core": _s(concept.get("core_en") or analysis.get("en_definition")),
        "collocations": collocations[:5],
        "common_errors": errors[:3],
    }


@router.post("/ai-questions")
async def ai_questions(body: AiQuestionsBody):
    words = []
    for word in body.words:
        normalized = _s(word).lower()
        if normalized and normalized not in words:
            words.append(normalized)
    words = words[:AI_QUESTION_LIMIT]
    if not words:
        return JSONResponse({"error": "words required"}, status_code=400)
    summaries = [
        _word_summary(word, db.get_word_analysis_raw(word))
        for word in words
    ]
    prompt = RECALL_QUESTIONS_PROMPT.format(words_json=json.dumps(summaries, ensure_ascii=False, indent=1))
    try:
        resp = await run_in_threadpool(
            ai_config.client.chat.completions.create,
            **json_completion_kwargs(prompt, temperature=0.7, max_tokens=300 + 250 * len(words)),
        )
        raw = parse_ai_json(resp.choices[0])
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=500)
    questions = []
    for item in raw.get("questions") or []:
        if not isinstance(item, dict):
            continue
        word = _s(item.get("word")).lower()
        question = _s(item.get("question"))
        if word not in words or not question or any(q["word"] == word for q in questions):
            continue
        qtype = _s(item.get("type")).lower()
        questions.append({
            "word": word,
            "type": qtype if qtype in QUESTION_TYPES else "translate",
            "question": question,
            "answer": _s(item.get("answer")),
            "explanation": _s(item.get("explanation")),
        })
    if not questions:
        return JSONResponse({"error": "AI 未能生成有效题目，请重试"}, status_code=500)
    return {"questions": questions}


@router.post("/results")
def save_results(body: ResultsBody):
    changes = db.record_recall_results([item.model_dump() for item in body.results])
    return {"changes": changes}


@router.post("/undo")
def undo_result(body: UndoBody):
    try:
        ok = db.undo_recall_result(body.word, body.familiarity, body.next_review or "")
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    if not ok:
        return JSONResponse({"error": "word not found"}, status_code=404)
    return {"ok": True}


@router.get("/last-results")
def last_results():
    return {"results": db.get_last_recall_results()}
