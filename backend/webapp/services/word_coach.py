"""Normalize the "word coach" deep analysis and derive legacy fields.

The analysis is stored in ``words.cached_analysis`` and read by many older
views (vocab book, review export, legacy lesson page).  Besides validating the
new nested structure, :func:`normalize_word_coach` fills the flat legacy keys
(``basic_meaning``, ``ipa``, ``pos``, ``en_definition``, ``usage``,
``collocations``, ``synonyms``, ``examples``) so those views keep working.
"""
from __future__ import annotations

from prompts import WORD_COACH_SCHEMA

MORPHEME_TYPES = ("prefix", "root", "suffix", "word")
COLLOCATION_CATEGORIES = ("verb", "noun", "adj_adv", "preposition", "phrase")
EXAMPLE_SCENES = ("daily", "work", "academic")
EXERCISE_TYPES = ("choose", "translate", "compare")

# Old deep-analysis keys that the new schema replaces; dropped on cache merge
LEGACY_ONLY_KEYS = ("ielts_note", "register")


def _s(value) -> str:
    return " ".join(str(value or "").split())


def _dict(value) -> dict:
    return value if isinstance(value, dict) else {}


def _list(value) -> list:
    return value if isinstance(value, list) else []


def _records(items, fields: tuple[str, ...], *, required: str, limit: int) -> list[dict]:
    out = []
    for item in _list(items):
        if not isinstance(item, dict):
            continue
        record = {field: _s(item.get(field)) for field in fields}
        if record[required]:
            out.append(record)
        if len(out) >= limit:
            break
    return out


def _choice(value, allowed: tuple[str, ...], default: str) -> str:
    text = _s(value).lower()
    return text if text in allowed else default


def is_word_coach(data) -> bool:
    return isinstance(data, dict) and str(data.get("schema") or "").startswith("word_coach_")


def normalize_word_coach(raw: dict, word: str) -> dict:
    if not isinstance(raw, dict):
        raise ValueError("AI 返回格式异常，请重试")
    recognition = _dict(raw.get("recognition"))
    morphology = _dict(recognition.get("morphology"))
    pronunciation = _dict(recognition.get("pronunciation"))
    concept = _dict(raw.get("concept"))
    usage = _dict(concept.get("usage"))
    building = _dict(raw.get("sentence_building"))

    parts = []
    for item in _list(morphology.get("parts"))[:6]:
        if isinstance(item, dict) and _s(item.get("part")):
            parts.append({
                "part": _s(item.get("part")),
                "type": _choice(item.get("type"), MORPHEME_TYPES, "root"),
                "meaning": _s(item.get("meaning")),
            })

    groups = []
    total_collocations = 0
    for group in _list(raw.get("collocation_groups")):
        if not isinstance(group, dict):
            continue
        items = _records(group.get("items"), ("phrase", "en", "cn", "example"), required="phrase", limit=6)
        items = items[: max(0, 10 - total_collocations)]
        if not items:
            continue
        total_collocations += len(items)
        groups.append({
            "category": _choice(group.get("category"), COLLOCATION_CATEGORIES, "phrase"),
            "items": items,
        })

    examples = []
    for item in _list(building.get("examples"))[:5]:
        if isinstance(item, dict) and _s(item.get("en")):
            examples.append({
                "scene": _choice(item.get("scene"), EXAMPLE_SCENES, "daily"),
                "en": _s(item.get("en")),
                "cn": _s(item.get("cn")),
            })

    exercises = []
    for item in _list(raw.get("exercises"))[:3]:
        if not isinstance(item, dict) or not _s(item.get("question")):
            continue
        exercise_type = _choice(item.get("type"), EXERCISE_TYPES, "translate")
        options = [_s(option) for option in _list(item.get("options")) if _s(option)][:4]
        exercises.append({
            "type": exercise_type,
            "question": _s(item.get("question")),
            "options": options if exercise_type != "translate" else [],
            "answer": _s(item.get("answer")),
            "explanation": _s(item.get("explanation")),
        })

    senses = _records(concept.get("senses"), ("pos", "sense_en", "sense_cn", "link"), required="sense_en", limit=4)
    core_en = _s(concept.get("core_en"))
    if not core_en and not senses:
        raise ValueError("AI 未返回核心概念，请重试")

    result = {
        "schema": WORD_COACH_SCHEMA,
        "word": _s(raw.get("word")) or word,
        "basic_meaning": _s(raw.get("basic_meaning")),
        "contextual_meaning": _s(raw.get("contextual_meaning")),
        "recognition": {
            "morphology": {
                "splittable": bool(morphology.get("splittable")) and bool(parts),
                "parts": parts,
                "explanation": _s(morphology.get("explanation")),
                "etymology": _s(morphology.get("etymology")),
            },
            "pronunciation": {
                "ipa_us": _s(pronunciation.get("ipa_us")),
                "ipa_uk": _s(pronunciation.get("ipa_uk")),
                "syllables": _s(pronunciation.get("syllables")),
                "stress": _s(pronunciation.get("stress")),
                "spelling_to_sound": _records(
                    pronunciation.get("spelling_to_sound"), ("letters", "sound", "note"),
                    required="letters", limit=8,
                ),
                "irregular": _s(pronunciation.get("irregular")),
                "pitfalls": _s(pronunciation.get("pitfalls")),
            },
        },
        "concept": {
            "core_en": core_en,
            "core_cn": _s(concept.get("core_cn")),
            "mental_picture": _s(concept.get("mental_picture")),
            "senses": senses,
            "usage": {
                key: _s(usage.get(key))
                for key in ("daily", "work_academic", "most_natural", "prefer_others")
            },
        },
        "collocation_groups": groups,
        "sentence_building": {
            "forms": _s(building.get("forms")),
            "patterns": _records(building.get("patterns"), ("pattern", "note", "example"), required="pattern", limit=4),
            "common_errors": _records(building.get("common_errors"), ("wrong", "right", "why"), required="right", limit=3),
            "examples": examples,
        },
        "similar_words": _records(
            raw.get("similar_words"), ("word", "core", "usage", "collocation", "not_interchangeable"),
            required="word", limit=3,
        ),
        "exercises": exercises,
    }
    result.update(_legacy_fields(result))
    if not result["basic_meaning"]:
        # 缓存合并时不要用空值覆盖词汇本里已有的中文释义
        result.pop("basic_meaning")
    return result


def _legacy_fields(coach: dict) -> dict:
    """Flat fields read by older views and by the vocab book."""
    concept = coach["concept"]
    pronunciation = coach["recognition"]["pronunciation"]
    building = coach["sentence_building"]
    pos_list = []
    for sense in concept["senses"]:
        if sense["pos"] and sense["pos"] not in pos_list:
            pos_list.append(sense["pos"])
    basic = coach["basic_meaning"] or "；".join(
        sense["sense_cn"] for sense in concept["senses"] if sense["sense_cn"]
    )[:60]
    return {
        "basic_meaning": basic,
        "pos": " / ".join(pos_list),
        "ipa": pronunciation["ipa_us"] or pronunciation["ipa_uk"],
        "en_definition": concept["core_en"] or (concept["senses"][0]["sense_en"] if concept["senses"] else ""),
        "usage": "；".join(
            f"{p['pattern']}（{p['note']}）" if p["note"] else p["pattern"] for p in building["patterns"]
        ),
        "collocations": [
            f"{item['phrase']}（{item['cn']}）" if item["cn"] else item["phrase"]
            for group in coach["collocation_groups"]
            for item in group["items"]
        ][:8],
        "synonyms": [
            {"word": item["word"], "difference": item["core"]} for item in coach["similar_words"]
        ],
        "examples": [item["en"] for item in building["examples"]],
    }
