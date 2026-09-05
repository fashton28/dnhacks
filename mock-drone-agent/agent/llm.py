"""Thin wrapper around the Claude API.

Two jobs:
  1. Keep every model-facing detail (model id, thinking, caching) in one place.
  2. Degrade to `mock` mode when there are no credentials, so the whole pipeline
     still runs end-to-end with zero setup. Everything except this file is
     identical in mock and live mode.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

# Claude Opus 5. Override with DRONE_AGENT_MODEL=claude-sonnet-5 for a cheaper,
# faster demo loop.
MODEL = os.environ.get("DRONE_AGENT_MODEL", "claude-opus-5")

# low | medium | high | xhigh | max. Lower this if live demo latency is a problem.
EFFORT = os.environ.get("DRONE_AGENT_EFFORT", "high")

MAX_TOKENS = 8_000


class LLMError(RuntimeError):
    pass


def credentials_available() -> bool:
    if os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"):
        return True
    # `ant auth login` stores a profile the SDK picks up with no env var set.
    return (Path.home() / ".config" / "anthropic").exists()


def sdk_available() -> bool:
    try:
        import anthropic  # noqa: F401
    except ImportError:
        return False
    return True


class LLM:
    """`mode` is 'auto' (live if possible), 'live' (fail loudly), or 'mock'."""

    def __init__(self, mode: str = "auto") -> None:
        if mode not in ("auto", "live", "mock"):
            raise ValueError(f"unknown LLM mode: {mode!r}")

        if mode == "mock":
            self.mock = True
            self.reason = "explicitly requested"
        elif not sdk_available():
            if mode == "live":
                raise LLMError("the `anthropic` package is not installed: pip install anthropic")
            self.mock, self.reason = True, "the `anthropic` package is not installed"
        elif not credentials_available():
            if mode == "live":
                raise LLMError(
                    "no Anthropic credentials found. Either export ANTHROPIC_API_KEY=... "
                    "or run `ant auth login`."
                )
            self.mock, self.reason = True, "no Anthropic credentials found"
        else:
            self.mock, self.reason = False, ""

        self._client = None
        if not self.mock:
            import anthropic

            self._client = anthropic.Anthropic()

    @property
    def model(self) -> str:
        return "mock" if self.mock else MODEL

    def create(
        self,
        *,
        system: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        max_tokens: int = MAX_TOKENS,
    ) -> Any:
        """One Messages API call with a tool available.

        The system prompt is sent as a cacheable block: it contains the facility
        brief, which is byte-identical across every mission in a run, so after
        the first call it is served from cache.
        """
        if self.mock:
            raise LLMError("LLM.create() called in mock mode — use the mock planner instead")

        import anthropic

        try:
            response = self._client.messages.create(
                model=MODEL,
                max_tokens=max_tokens,
                thinking={"type": "adaptive"},
                output_config={"effort": EFFORT},
                system=[
                    {
                        "type": "text",
                        "text": system,
                        "cache_control": {"type": "ephemeral"},
                    }
                ],
                tools=tools,
                messages=messages,
            )
        except anthropic.AuthenticationError as exc:
            raise LLMError(f"authentication failed — check ANTHROPIC_API_KEY ({exc})") from exc
        except anthropic.RateLimitError as exc:
            raise LLMError(f"rate limited; retry in a moment ({exc})") from exc
        except anthropic.BadRequestError as exc:
            raise LLMError(f"bad request to the Claude API: {exc}") from exc
        except anthropic.APIConnectionError as exc:
            raise LLMError(f"could not reach the Claude API: {exc}") from exc

        if response.stop_reason == "refusal":
            detail = getattr(response, "stop_details", None)
            raise LLMError(
                "the model declined this request"
                + (f" (category: {detail.category})" if detail else "")
            )
        return response


def first_tool_use(response: Any, name: str) -> tuple[str, dict[str, Any]] | None:
    """Return (tool_use_id, input) for the first call to `name`, or None."""
    for block in response.content:
        if block.type == "tool_use" and block.name == name:
            # Tool inputs are already parsed dicts; never string-match the raw JSON.
            return block.id, dict(block.input)
    return None


def response_text(response: Any) -> str:
    return "\n".join(b.text for b in response.content if b.type == "text").strip()
