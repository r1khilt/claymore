"""Offline contracts for the restricted Claude Agent SDK Composer adapter."""

from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from typing import Any, ClassVar, cast

import pytest

import claymore.agent.sdk_loop as sdk_loop
import claymore.api.routes.agent as agent_route
from claymore.agent import RequestContext
from claymore.agent.agent_loop import (
    AnalysisEvent,
    AnswerEvent,
    DoneEvent,
    ScienceSessionEvent,
    ScienceStepEvent,
    ThoughtEvent,
    ToolEndEvent,
    ToolStartEvent,
)
from claymore.agent.router import default_runtime
from claymore.execute.claude_science import ScienceMetric, ScienceSession, ScienceStep
from claymore.memory.graph import InMemoryMemoryStore
from tests.fixtures import LAB, make_episode, make_settings

CTX = RequestContext(user_id="u_lucas", lab_id=LAB, group_ids=(LAB,))

_Handler = Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]


@dataclass
class _FakeTool:
    name: str
    description: str
    input_schema: dict[str, Any]
    handler: _Handler


def _fake_tool(
    name: str, description: str, input_schema: dict[str, Any]
) -> Callable[[_Handler], object]:
    def decorate(handler: _Handler) -> object:
        return _FakeTool(name, description, input_schema, handler)

    return decorate


@dataclass
class _FakeServer:
    name: str
    version: str
    tools: list[_FakeTool]


def _fake_server(*, name: str, version: str, tools: list[object]) -> object:
    return _FakeServer(name, version, [cast("_FakeTool", tool) for tool in tools])


class _FakeOptions:
    last: ClassVar[_FakeOptions | None] = None

    def __init__(self, **values: Any) -> None:
        self.values = values
        _FakeOptions.last = self


class _FakeHookMatcher:
    def __init__(self, *, hooks: list[Callable[..., Awaitable[dict[str, Any]]]]) -> None:
        self.hooks = hooks


@dataclass
class _FakeTextBlock:
    text: str


@dataclass
class _FakeAssistantMessage:
    content: list[object]


@dataclass
class _FakeResultMessage:
    result: str | None
    usage: dict[str, int]
    num_turns: int
    is_error: bool = False
    subtype: str = "success"


class _FakeUnavailableError(Exception):
    pass


class _FakeClient:
    tool_name: ClassVar[str] = "search_memory"
    tool_args: ClassVar[dict[str, Any]] = {
        "query": "what did Lucas suggest about the protein hypothesis?"
    }
    last_prompt: ClassVar[str] = ""
    last_tool_result: ClassVar[dict[str, Any] | None] = None

    def __init__(self, *, options: object) -> None:
        assert isinstance(options, _FakeOptions)
        self.options = options

    async def __aenter__(self) -> _FakeClient:
        return self

    async def __aexit__(
        self,
        _exc_type: object | None,
        _exc_value: object | None,
        _traceback: object | None,
    ) -> bool:
        return False

    async def query(self, prompt: str, session_id: str = "default") -> None:
        del session_id
        type(self).last_prompt = prompt

    async def receive_response(self) -> AsyncIterator[object]:
        yield _FakeAssistantMessage([_FakeTextBlock("I will use the scoped Claymore tool.")])

        servers = cast("dict[str, _FakeServer]", self.options.values["mcp_servers"])
        server = servers["claymore"]
        selected = next(tool for tool in server.tools if tool.name == type(self).tool_name)
        type(self).last_tool_result = await selected.handler(dict(type(self).tool_args))

        yield _FakeAssistantMessage([_FakeTextBlock("Lucas suggested the protein hypothesis.")])
        yield _FakeResultMessage(
            result="Lucas suggested the protein hypothesis.",
            usage={"input_tokens": 120, "output_tokens": 30},
            num_turns=2,
        )


class _FakeErrorResultClient(_FakeClient):
    """Mirror the SDK's terminal-error-result followed by a non-zero CLI exit."""

    async def receive_response(self) -> AsyncIterator[object]:
        yield _FakeAssistantMessage([_FakeTextBlock("I reached the bounded turn limit.")])
        yield _FakeResultMessage(
            result="I found a partial grounded answer.",
            usage={"input_tokens": 80, "output_tokens": 20},
            num_turns=3,
            is_error=True,
            subtype="error_max_turns",
        )
        raise _FakeUnavailableError("intentional non-zero CLI exit after result")


def _bindings() -> sdk_loop._SdkBindings:
    return sdk_loop._SdkBindings(
        options_factory=_FakeOptions,
        client_factory=_FakeClient,
        hook_matcher_factory=_FakeHookMatcher,
        tool_decorator_factory=_fake_tool,
        create_server=_fake_server,
        assistant_message_type=_FakeAssistantMessage,
        result_message_type=_FakeResultMessage,
        text_block_type=_FakeTextBlock,
        unavailable_errors=(_FakeUnavailableError,),
    )


def _error_result_bindings() -> sdk_loop._SdkBindings:
    bindings = _bindings()
    return sdk_loop._SdkBindings(
        options_factory=bindings.options_factory,
        client_factory=_FakeErrorResultClient,
        hook_matcher_factory=bindings.hook_matcher_factory,
        tool_decorator_factory=bindings.tool_decorator_factory,
        create_server=bindings.create_server,
        assistant_message_type=bindings.assistant_message_type,
        result_message_type=bindings.result_message_type,
        text_block_type=bindings.text_block_type,
        unavailable_errors=bindings.unavailable_errors,
    )


async def _seeded_store() -> InMemoryMemoryStore:
    store = InMemoryMemoryStore()
    await store.add_episode(make_episode())
    return store


def test_safe_tool_surface_includes_claude_science_but_excludes_ingest() -> None:
    specs = sdk_loop._safe_tool_specs()
    names = tuple(spec.name for spec in specs)

    assert names == (
        "search_memory",
        "generate_opentrons_protocol",
        "run_bio_analysis",
        "simulate_protocol",
        "run_ml_analysis",
        "run_claude_science",
    )
    # Ingest stays gated to the connector surface; Claude Science is now an allowed tool (it drives
    # the loopback-locked local app, so it cannot reach off-host).
    assert "ingest_source" not in names
    assert "run_claude_science" in names
    assert "SIMULATED" in next(s.description for s in specs if s.name == "run_bio_analysis")
    for spec in specs:
        assert spec.input_schema["additionalProperties"] is False
        properties = cast("dict[str, object]", spec.input_schema["properties"])
        assert not {"user_id", "lab_id", "connected_account_id"} & properties.keys()


def test_task_budget_floored_at_model_minimum() -> None:
    # Opus 4.8 rejects task_budget.total < 20_000; the small reasoning-level max_tokens must be
    # raised to that floor, and None/0/negative must not fall below it either.
    assert sdk_loop._resolve_task_budget(2048) == 20_000  # below floor -> raised
    assert sdk_loop._resolve_task_budget(None) == 20_000  # unset -> floor
    assert sdk_loop._resolve_task_budget(0) == 20_000  # zero -> floor
    assert sdk_loop._resolve_task_budget(-5) == 20_000  # negative -> floor
    assert sdk_loop._resolve_task_budget(50_000) == 50_000  # above floor -> passed through
    assert sdk_loop._resolve_task_budget(20_000) == 20_000  # exactly the floor


async def test_default_deny_hook_allows_only_fully_qualified_safe_tools() -> None:
    allowed_name = "mcp__claymore__search_memory"
    guard = sdk_loop._pre_tool_guard(frozenset({allowed_name}))

    assert await guard({"tool_name": allowed_name}, None, object()) == {}
    denied = await guard({"tool_name": "Bash"}, None, object())
    output = cast("dict[str, object]", denied["hookSpecificOutput"])
    assert output["permissionDecision"] == "deny"
    assert await guard({}, None, object()) != {}


async def test_sdk_loop_preserves_events_usage_and_provenance(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(sdk_loop, "_load_sdk", _bindings)
    monkeypatch.setattr(_FakeClient, "tool_name", "search_memory")
    monkeypatch.setattr(
        _FakeClient,
        "tool_args",
        {"query": "what did Lucas suggest about the protein hypothesis?"},
    )
    store = await _seeded_store()
    settings = make_settings(anthropic_api_key="sk-test", query_model="claude-test")

    events = [
        event
        async for event in sdk_loop.run_sdk_agent(
            CTX,
            "What did Lucas suggest?",
            store,
            settings,
            max_iterations=4,
            max_tokens=2048,
        )
    ]

    options = _FakeOptions.last
    assert options is not None
    values = options.values
    assert values["tools"] == []
    assert values["setting_sources"] == []
    assert values["skills"] == []
    assert values["plugins"] == []
    assert values["strict_mcp_config"] is True
    assert values["permission_mode"] == "dontAsk"
    assert values["max_turns"] == 4
    # task_budget is floored at the model's API minimum (Opus 4.8 rejects < 20_000), so the small
    # per-turn max_tokens (2048) is raised to the floor rather than passed through as-is.
    assert values["task_budget"] == {"total": 20_000}
    assert values["model"] == "claude-test"
    assert set(values["allowed_tools"]) == {
        f"mcp__claymore__{name}" for name in sdk_loop.SAFE_TOOL_NAMES
    }
    assert "Source ingestion/synchronization" in values["system_prompt"]

    assert _FakeClient.last_prompt == "What did Lucas suggest?"
    assert _FakeClient.last_tool_result is not None
    assert _FakeClient.last_tool_result["is_error"] is False

    starts = [event for event in events if isinstance(event, ToolStartEvent)]
    ends = [event for event in events if isinstance(event, ToolEndEvent)]
    assert [event.tool for event in starts] == ["search_memory"]
    assert len(ends) == 1 and ends[0].id == starts[0].id and ends[0].ok

    answers = [event for event in events if isinstance(event, AnswerEvent)]
    assert len(answers) == 1
    assert answers[0].citations
    assert answers[0].citations[0].source_id == "m1"
    assert answers[0].citations[0].author == "p_lucas"

    thoughts = [event.text for event in events if isinstance(event, ThoughtEvent)]
    assert thoughts[-1] == answers[0].text
    done = next(event for event in events if isinstance(event, DoneEvent))
    assert done.input_tokens == 120
    assert done.output_tokens == 30
    assert done.iterations == 2
    assert done.tool_calls == 1
    assert done.tool_counts == {"search_memory": 1}


async def test_simulated_bio_result_is_labelled_in_every_ui_event(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(sdk_loop, "_load_sdk", _bindings)
    monkeypatch.setattr(_FakeClient, "tool_name", "run_bio_analysis")
    monkeypatch.setattr(
        _FakeClient,
        "tool_args",
        {"kind": "structure_prediction", "target": "CBX2"},
    )
    _FakeClient.last_tool_result = None

    events = [
        event
        async for event in sdk_loop.run_sdk_agent(
            CTX,
            "Preview a structure prediction",
            InMemoryMemoryStore(),
            make_settings(anthropic_api_key="sk-test"),
        )
    ]

    analysis = next(event for event in events if isinstance(event, AnalysisEvent))
    assert analysis.analysis.title.startswith("Simulated preview ·")
    assert "no scientific compute ran" in analysis.analysis.summary
    tool_end = next(event for event in events if isinstance(event, ToolEndEvent))
    assert tool_end.summary.startswith("Simulated preview ·")
    assert _FakeClient.last_tool_result is not None
    observation = cast("list[dict[str, str]]", _FakeClient.last_tool_result["content"])[0]["text"]
    assert "simulated result" in observation


async def test_claude_science_streams_steps_and_result_through_sdk(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # run_claude_science is now a first-class SDK tool: it must stream a ScienceStep panel and a
    # terminal ScienceSession, and its completed/preview status must survive into the UI events.
    _shot = "data:image/svg+xml;base64,AAA"

    async def _fake_science(task: str, _settings: object, **_kw: object) -> AsyncIterator[object]:
        yield ScienceStep(index=1, action="connect", detail="Signed in", screenshot=_shot)
        yield ScienceSession(
            task=task,
            status="completed",
            url="http://localhost:8765",
            model="claude-opus-4-8",
            steps=[ScienceStep(index=1, action="connect", detail="Signed in", screenshot=_shot)],
            result_title="Claude Science · analyze BRCA1",
            result_summary="BRCA1 c.68_69delAG is pathogenic (real run).",
            metrics=[ScienceMetric(label="model", value="Opus 4.8")],
            note=None,
        )

    monkeypatch.setattr(sdk_loop, "_load_sdk", _bindings)
    monkeypatch.setattr(sdk_loop, "run_science_session", _fake_science)
    monkeypatch.setattr(_FakeClient, "tool_name", "run_claude_science")
    monkeypatch.setattr(_FakeClient, "tool_args", {"task": "analyze BRCA1 c.68_69delAG"})
    _FakeClient.last_tool_result = None

    events = [
        event
        async for event in sdk_loop.run_sdk_agent(
            CTX,
            "using claude science, analyze BRCA1",
            InMemoryMemoryStore(),
            make_settings(anthropic_api_key="sk-test"),
        )
    ]

    step_ev = next(e for e in events if isinstance(e, ScienceStepEvent))
    assert step_ev.step.detail == "Signed in"
    session_ev = next(e for e in events if isinstance(e, ScienceSessionEvent))
    assert session_ev.session.status == "completed"
    assert "pathogenic" in session_ev.session.result_summary
    tool_end = next(e for e in events if isinstance(e, ToolEndEvent))
    assert tool_end.ok
    done = next(e for e in events if isinstance(e, DoneEvent))
    assert done.tool_counts == {"run_claude_science": 1}


async def test_terminal_sdk_error_result_survives_trailing_cli_process_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(sdk_loop, "_load_sdk", _error_result_bindings)

    events = [
        event
        async for event in sdk_loop.run_sdk_agent(
            CTX,
            "Find what you can within the turn limit",
            InMemoryMemoryStore(),
            make_settings(anthropic_api_key="sk-test"),
            max_iterations=3,
        )
    ]

    answer = next(event for event in events if isinstance(event, AnswerEvent))
    assert answer.text == "I found a partial grounded answer."
    error = next(event for event in events if isinstance(event, sdk_loop.ErrorEvent))
    assert error.message == "The agent reached its bounded turn limit before finishing."
    done = next(event for event in events if isinstance(event, DoneEvent))
    assert done.input_tokens == 80
    assert done.output_tokens == 20
    assert done.iterations == 3


async def test_route_uses_restricted_direct_loop_only_when_sdk_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    async def unavailable(*_args: object, **_kwargs: object) -> AsyncIterator[object]:
        if False:
            yield object()
        raise sdk_loop.AgentSdkUnavailable("not installed")

    async def compatibility(*_args: object, **kwargs: object) -> AsyncIterator[object]:
        captured.update(kwargs)
        yield DoneEvent()

    monkeypatch.setattr(agent_route, "run_sdk_agent", unavailable)
    monkeypatch.setattr(agent_route, "run_agent", compatibility)
    monkeypatch.setattr(agent_route, "get_runtime", default_runtime)
    monkeypatch.setattr(agent_route.local_store, "reasoning_budget", lambda: (3, 1024))
    monkeypatch.setattr(agent_route.local_store, "record_run", lambda **_kwargs: None)
    monkeypatch.setattr(agent_route.local_store, "record_error", lambda *_args, **_kwargs: None)

    frames = [
        frame
        async for frame in agent_route._event_stream(
            "hello", [], make_settings(anthropic_api_key="sk-test")
        )
    ]

    assert "restricted compatibility loop" in frames[0]
    assert captured["allowed_tool_names"] == sdk_loop.SAFE_TOOL_NAMES
    assert captured["max_iterations"] == 3
    assert captured["max_tokens"] == 1024
