"""点词卡片「此处」语境义：用 AI 给出单词在当前句子里的中文意思。

词典释义由 lookup_word_meaning 秒开；语境义是第二段异步请求，失败或未配置
AI 时返回空，前端只显示词典释义。结果按 (词, 句子) 缓存在进程内存里。
"""
from __future__ import annotations

import re
import threading
from collections import OrderedDict

from prompts import WORD_CONTEXT_MEANING_PROMPT
from webapp.runtime import ai_config, credit_meter
from webapp.services.ai_json import json_completion_kwargs, parse_ai_json

_MAX_SENTENCE_CHARS = 400
_CACHE_LIMIT = 512
_CACHE: OrderedDict[tuple[str, str], dict] = OrderedDict()
_CACHE_LOCK = threading.Lock()
_POS_ALLOWED = {"n.", "v.", "adj.", "adv.", "prep.", "conj.", "pron.", "phr.", "num.", "int.", "art."}
_CJK_RE = re.compile(r"[一-鿿]")


def _clean(value, limit: int) -> str:
    return " ".join(str(value or "").split())[:limit]


def normalize_sentence(sentence: str) -> str:
    return " ".join(str(sentence or "").split())[:_MAX_SENTENCE_CHARS]


def context_meaning_available() -> bool:
    """计费激活时不在每次点词上静默调用可计费 AI；单用户/公开库只看是否配置了 key。"""
    return bool(ai_config.AI_API_KEY) and not credit_meter.billing_active()


def lookup_context_meaning(word: str, sentence: str) -> dict:
    """返回 {"meaning", "pos", "note"}；不可用或失败时 meaning 为空。"""
    word = _clean(word, 64).lower()
    sentence = normalize_sentence(sentence)
    empty = {"meaning": "", "pos": "", "note": ""}
    if not word or not sentence or word not in sentence.lower():
        return empty
    key = (word, sentence)
    with _CACHE_LOCK:
        if key in _CACHE:
            _CACHE.move_to_end(key)
            return dict(_CACHE[key])
    if not context_meaning_available():
        return empty
    prompt = WORD_CONTEXT_MEANING_PROMPT.format(word=word, sentence=sentence)
    response = ai_config.client.chat.completions.create(
        **json_completion_kwargs(prompt, temperature=0.1, max_tokens=160),
    )
    payload = parse_ai_json(response.choices[0])
    meaning = _clean(payload.get("meaning"), 40)
    if not _CJK_RE.search(meaning):
        return empty
    pos = _clean(payload.get("pos"), 8).lower()
    result = {
        "meaning": meaning,
        "pos": pos if pos in _POS_ALLOWED else "",
        "note": _clean(payload.get("note"), 60),
    }
    with _CACHE_LOCK:
        _CACHE[key] = result
        while len(_CACHE) > _CACHE_LIMIT:
            _CACHE.popitem(last=False)
    return dict(result)
