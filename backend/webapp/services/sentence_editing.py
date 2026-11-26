"""Learner-side corrections of a lesson's sentences: edit text, split, merge, delete.

Media lessons (video/audio) derive sentences from subtitle segments on every
request.  The first edit "freezes" the sentences the learner currently sees
into one manual segment per sentence (keeping the aligned times and word
timestamps), so later automatic splitting never re-cuts them.

Reading lessons keep the corrected sentence list on each touched paragraph
(``manual_sentences``).  When the lesson has generated audio, the per-sentence
audio segments are edited in the same way so the timeline stays in step.
"""
from __future__ import annotations

import re

import db
from webapp.services.mfa_alignment import apply_aligned_unit_times
from webapp.services.media_reading import build_media_reading_blocks
from webapp.services.v2_translation import build_translation_units
from webapp.services.v2_tts import build_timed_reading_blocks, reading_block_sentence_texts

MEDIA_SOURCE_TYPES = {"youtube", "bilibili", "local_audio", "local_video", "uploaded_media"}
ACTIONS = {"replace", "merge_prev", "merge_next", "delete"}
MAX_PARTS = 20
MAX_SENTENCE_CHARS = 1500
_WORD_RE = re.compile(r"[A-Za-z0-9]+(?:['’][A-Za-z0-9]+)*")


class SentenceEditError(ValueError):
    """Invalid edit request; message is shown to the learner."""


class StaleSentenceError(SentenceEditError):
    """The sentence changed since the page loaded."""


def _norm(text) -> str:
    return " ".join(str(text or "").split())


def _clean_parts(texts) -> list[str]:
    parts = [_norm(text) for text in (texts or [])]
    parts = [part for part in parts if part]
    if not parts:
        raise SentenceEditError("句子内容不能为空；如需删除请用“删除这句”")
    if len(parts) > MAX_PARTS:
        raise SentenceEditError(f"一次最多拆成 {MAX_PARTS} 句")
    for part in parts:
        if len(part) > MAX_SENTENCE_CHARS:
            raise SentenceEditError("单句太长了，请拆开后再保存")
        if not _WORD_RE.search(part):
            raise SentenceEditError("每一句至少要包含一个英文单词或数字")
    return parts


def _is_media_lesson(lesson: dict) -> bool:
    return str(lesson.get("source_type") or "") in MEDIA_SOURCE_TYPES


def _has_generated_audio(lesson: dict) -> bool:
    return (
        str(lesson.get("source_type") or "").startswith("reading")
        and str(lesson.get("media_kind") or "") == "generated_audio"
        and bool(str(lesson.get("media_url") or "").strip())
    )


# ── timed item operations (shared by media segments and reading audio) ──────


def _split_timed(item: dict, parts: list[str]) -> list[dict]:
    """Split one timed sentence into parts; boundaries from word timestamps when
    they line up with the text, otherwise proportional to character length."""
    start = float(item.get("start") or 0)
    end = float(item.get("end") or start)
    words = list(item.get("words") or [])
    counts = [len(_WORD_RE.findall(part)) for part in parts]
    boundaries: list[float] | None = None
    if words and sum(counts) == len(words):
        boundaries = []
        cursor = 0
        for count in counts[:-1]:
            cursor += count
            boundaries.append(float(words[cursor].get("start") or 0))
    if boundaries is None or any(b < start or b > end for b in boundaries):
        total = sum(max(1, len(part)) for part in parts)
        boundaries = []
        acc = 0
        for part in parts[:-1]:
            acc += max(1, len(part))
            boundaries.append(start + (end - start) * acc / total)
    edges = [start, *boundaries, end]
    out = []
    word_cursor = 0
    for index, part in enumerate(parts):
        piece = {**item, "text": part, "start": edges[index], "end": edges[index + 1]}
        if words and sum(counts) == len(words):
            piece["words"] = words[word_cursor:word_cursor + counts[index]]
            word_cursor += counts[index]
        else:
            piece.pop("words", None)
        out.append(piece)
    return out


def _merge_timed(first: dict, second: dict) -> dict:
    merged = {
        **first,
        "text": f"{first['text']} {second['text']}",
        "start": float(first.get("start") or 0),
        "end": float(second.get("end") or second.get("start") or 0),
    }
    if first.get("words") or second.get("words"):
        merged["words"] = list(first.get("words") or []) + list(second.get("words") or [])
    return merged


def _apply_timed(items: list[dict], position: int, action: str, parts: list[str]) -> list[dict]:
    items = list(items)
    if action == "replace":
        if len(parts) == 1:
            replacement = [{**items[position], "text": parts[0]}]
        else:
            replacement = _split_timed(items[position], parts)
        items[position:position + 1] = replacement
    elif action == "merge_next":
        items[position:position + 2] = [_merge_timed(items[position], items[position + 1])]
    elif action == "merge_prev":
        items[position - 1:position + 1] = [_merge_timed(items[position - 1], items[position])]
    elif action == "delete":
        del items[position]
    return items


def _check_neighbours(count: int, position: int, action: str) -> None:
    if action == "merge_next" and position + 1 >= count:
        raise SentenceEditError("这已经是最后一句，没有下一句可以合并")
    if action == "merge_prev" and position == 0:
        raise SentenceEditError("这已经是第一句，没有上一句可以合并")
    if action == "delete" and count <= 1:
        raise SentenceEditError("课程至少要保留一句")


# ── media lessons ─────────────────────────────────────────────────────────


def _words_for_unit(segments_by_index: dict[int, dict], unit: dict) -> list[dict]:
    start = float(unit.get("start") or 0) - 0.05
    end = float(unit.get("end") or 0) + 0.05
    words = []
    for segment_id in unit.get("segment_ids") or []:
        for word in segments_by_index.get(int(segment_id), {}).get("words") or []:
            word_start = float(word.get("start") or 0)
            if start <= word_start < end:
                words.append(word)
    return words


def _current_media_items(lesson_id: int) -> list[dict]:
    """The sentences the learner sees, as manual segments (index = unit index)."""
    segments = db.get_v2_subtitle_segments(lesson_id)
    units = apply_aligned_unit_times(lesson_id, build_translation_units(segments))
    by_index = {int(segment["index"]): segment for segment in segments}
    items = []
    for unit in units:
        item = {
            "text": _norm(unit["text"]),
            "start": float(unit.get("start") or 0),
            "end": float(unit.get("end") or 0),
        }
        words = _words_for_unit(by_index, unit)
        if words:
            item["words"] = words
        items.append(item)
    return items


def _edit_media(lesson_id: int, unit_index, original_text: str, action: str, parts: list[str]) -> list[str]:
    items = _current_media_items(lesson_id)
    try:
        position = int(unit_index)
    except (TypeError, ValueError):
        raise SentenceEditError("缺少要修改的句子位置") from None
    if not 0 <= position < len(items) or items[position]["text"] != original_text:
        raise StaleSentenceError("这句内容已经变化，请刷新页面后再改")
    _check_neighbours(len(items), position, action)
    items = _apply_timed(items, position, action, parts)
    segments = [
        {**item, "index": index, "manual": True}
        for index, item in enumerate(items)
    ]
    db.replace_v2_subtitle_segments(lesson_id, segments)
    db.replace_v2_reading_blocks(lesson_id, build_media_reading_blocks(segments))
    return [item["text"] for item in items]


# ── reading lessons ───────────────────────────────────────────────────────


def _edit_reading(
    lesson_id: int, lesson: dict, *, block_index, sentence_index, unit_index,
    original_text: str, action: str, parts: list[str],
) -> list[str]:
    blocks = db.get_v2_reading_blocks(lesson_id)
    generated_audio = _has_generated_audio(lesson)
    segments = db.get_v2_subtitle_segments(lesson_id) if generated_audio else []
    if generated_audio and segments:
        timed = build_timed_reading_blocks(blocks, segments)
        if timed != blocks:
            blocks = timed
    flat: list[tuple[int, str]] = []  # (block position, sentence text)
    for block_position, block in enumerate(blocks):
        for text in reading_block_sentence_texts(block):
            flat.append((block_position, text))

    position = None
    if block_index is not None and sentence_index is not None:
        try:
            target_block, target_sentence = int(block_index), int(sentence_index)
        except (TypeError, ValueError):
            raise SentenceEditError("句子位置无效") from None
        counter = 0
        for flat_position, (block_position, _) in enumerate(flat):
            if int(blocks[block_position]["index"]) != target_block:
                continue
            if counter == target_sentence:
                position = flat_position
                break
            counter += 1
    elif unit_index is not None:
        # 听力模式的句单元：按文本定位（唯一匹配才允许修改）
        hits = [i for i, (_, text) in enumerate(flat) if text == original_text]
        if len(hits) == 1:
            position = hits[0]
    if position is None or flat[position][1] != original_text:
        raise StaleSentenceError("这句内容已经变化，请刷新页面后再改")
    _check_neighbours(len(flat), position, action)
    sentence_count_before = len(flat)

    owner = flat[position][0]
    if action == "replace":
        flat[position:position + 1] = [(owner, part) for part in parts]
    elif action == "merge_next":
        flat[position:position + 2] = [(owner, f"{flat[position][1]} {flat[position + 1][1]}")]
    elif action == "merge_prev":
        previous_owner = flat[position - 1][0]
        flat[position - 1:position + 1] = [(previous_owner, f"{flat[position - 1][1]} {flat[position][1]}")]
    elif action == "delete":
        del flat[position]

    touched = {owner}
    if action == "merge_next":
        touched.add(owner + 1)
    if action == "merge_prev":
        touched.add(owner - 1)
    new_blocks = []
    for block_position, block in enumerate(blocks):
        texts = [text for owner_position, text in flat if owner_position == block_position]
        if not texts:
            continue  # 句子全部并入相邻段落：段落移除，保留其余段落编号不变
        updated = dict(block)
        if block_position in touched:
            updated["manual_sentences"] = texts
            updated["text"] = " ".join(texts)
            if not generated_audio:
                updated["sentences"] = []
        new_blocks.append(updated)

    if generated_audio and segments:
        timed_items = [
            {
                "text": _norm(segment.get("text")),
                "start": float(segment.get("start") or 0),
                "end": float(segment.get("end") or 0),
                **({"words": segment["words"]} if segment.get("words") else {}),
            }
            for segment in segments
        ]
        # 逐句音频段与显示句一一对应时才同步修改（否则只改文字，时间轴按词数重新分配）
        if len(timed_items) == sentence_count_before:
            timed_items = _apply_timed(timed_items, position, action, parts)
            new_segments = [
                {**item, "text": text, "index": index, "manual": True}
                for index, (item, (_, text)) in enumerate(zip(timed_items, flat))
            ]
            db.replace_v2_subtitle_segments(lesson_id, new_segments)
            new_blocks = build_timed_reading_blocks(new_blocks, new_segments)
    db.replace_v2_reading_blocks(lesson_id, new_blocks)
    return [text for _, text in flat]


# ── entry point ───────────────────────────────────────────────────────────


def edit_lesson_sentence(
    lesson_id: int,
    *,
    action: str,
    original_text: str,
    texts: list[str] | None = None,
    unit_index=None,
    block_index=None,
    sentence_index=None,
) -> dict:
    lesson = db.get_v2_lesson(lesson_id)
    if not lesson:
        raise LookupError("Lesson not found")
    action = str(action or "").strip()
    if action not in ACTIONS:
        raise SentenceEditError("不支持的修改操作")
    original_text = _norm(original_text)
    if not original_text:
        raise SentenceEditError("缺少原句内容")
    parts = _clean_parts(texts) if action == "replace" else []
    before = current_sentence_texts(lesson_id, lesson)
    if _is_media_lesson(lesson):
        sentences = _edit_media(lesson_id, unit_index, original_text, action, parts)
    elif str(lesson.get("source_type") or "").startswith("reading"):
        sentences = _edit_reading(
            lesson_id, lesson,
            block_index=block_index, sentence_index=sentence_index, unit_index=unit_index,
            original_text=original_text, action=action, parts=parts,
        )
    else:
        raise SentenceEditError("这种课程暂不支持修改句子")
    before_set = set(before)
    changed = [text for text in sentences if text not in before_set]
    return {"sentences": sentences, "changed": changed, "count": len(sentences)}


def current_sentence_texts(lesson_id: int, lesson: dict) -> list[str]:
    if _is_media_lesson(lesson):
        return [item["text"] for item in _current_media_items(lesson_id)]
    return [
        text
        for block in db.get_v2_reading_blocks(lesson_id)
        for text in reading_block_sentence_texts(block)
    ]


def untranslated_texts(texts: list[str]) -> list[str]:
    pending = []
    for text in texts:
        cached = db.get_v2_sentence(text)
        if not str((cached or {}).get("translation") or "").strip():
            pending.append(text)
    return pending
