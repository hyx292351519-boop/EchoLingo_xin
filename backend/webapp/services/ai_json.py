"""Shared helpers for chat completions that must return a JSON object."""
from __future__ import annotations

import json

from webapp.runtime import ai_config


def json_completion_kwargs(prompt: str, *, temperature: float, max_tokens: int) -> dict:
    """Chat-completion kwargs for a JSON reply.

    DeepSeek V4 thinks by default; its reasoning tokens count against
    max_tokens and can leave the visible reply empty, so thinking is disabled.
    """
    kwargs = {
        "model": ai_config.AI_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "response_format": {"type": "json_object"},
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if (
        "api.deepseek.com" in str(ai_config.AI_BASE_URL or "").lower()
        and str(ai_config.AI_MODEL).lower().startswith("deepseek-v4")
    ):
        kwargs["extra_body"] = {"thinking": {"type": "disabled"}}
    return kwargs


def parse_ai_json(choice) -> dict:
    """Parse the model's JSON reply, tolerating code fences and surrounding text."""
    finish_reason = str(getattr(choice, "finish_reason", "") or "").lower()
    text = str(getattr(choice.message, "content", "") or "").strip()
    if not text:
        if finish_reason == "length":
            raise ValueError("AI 输出被截断（返回为空），请重试")
        raise ValueError("AI 未返回内容，请重试")
    start, end = text.find("{"), text.rfind("}")
    try:
        if start < 0 or end <= start:
            raise ValueError
        parsed = json.loads(text[start:end + 1])
    except ValueError:
        if finish_reason == "length":
            raise ValueError("AI 输出被截断，请重试") from None
        raise ValueError("AI 返回的不是有效 JSON，请重试") from None
    if not isinstance(parsed, dict):
        raise ValueError("AI 返回格式异常，请重试")
    return parsed
