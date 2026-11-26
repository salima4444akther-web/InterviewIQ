import json

import httpx
import pytest
from fastapi.testclient import TestClient

from backend import main


@pytest.fixture(autouse=True)
def clear_auth_overrides():
    yield
    main.app.dependency_overrides.clear()


def make_client(tmp_path, monkeypatch, user_id="test-user"):
    monkeypatch.setattr(main, "DB_PATH", tmp_path / "interviewiq-test.sqlite3")
    main.initialize_database()
    main.app.dependency_overrides[main.require_user] = lambda: {"id": user_id}
    return TestClient(main.app)


def detailed_answer():
    return (
        "When I was coordinating a product launch, our team discovered a major data issue two days "
        "before release. My task was to find the cause and keep the launch on track. I organized a "
        "short review with engineering and support, then compared the affected records and found a "
        "mapping error. I proposed a fix, tested it with the team, and shared a clear rollout plan. "
        "As a result, we released on time and reduced the affected records by 25 percent. I also "
        "documented the checks so the team could catch the issue earlier next time."
    )


def ai_evaluation(gaps=None):
    return {
        "dimensions": [
            {
                "key": dimension["key"],
                "score": 4,
                "explanation": f"Clear evidence for {dimension['label'].lower()}.",
                "evidence": None,
            }
            for dimension in main.DIMENSIONS
        ],
        "gaps": gaps or [],
        "strengths": ["You explained your individual contribution."],
        "priority": "Evidence & impact",
        "recommendations": ["Add one measurable outcome if you have a real one."],
        "example": "Situation: [context]. Task: [responsibility]. Action: [steps]. Result: [real outcome].",
    }


def ai_technical_evaluation(gaps=None):
    return {
        "dimensions": [
            {
                "key": dimension["key"],
                "score": 4,
                "explanation": f"Clear technical evidence for {dimension['label'].lower()}.",
                "evidence": None,
            }
            for dimension in main.TECHNICAL_DIMENSIONS
        ],
        "gaps": gaps or [],
        "strengths": ["You explained the approach clearly."],
        "priority": "Testing & edge cases",
        "recommendations": ["Test a boundary case before finalizing the solution."],
        "example": "Clarify assumptions → outline a solution → analyze complexity → test edge cases.",
    }


def test_complete_interview_and_revise_answer(tmp_path, monkeypatch):
    with make_client(tmp_path, monkeypatch) as client:
        created = client.post(
            "/api/interviews",
            json={
                "role": "Product Manager",
                "interview_type": "Behavioral",
                "difficulty": "Intermediate",
                "duration_minutes": 15,
                "focus_competency": "Mixed",
            },
        )
        assert created.status_code == 201
        session_id = created.json()["id"]

        started = client.post(f"/api/interviews/{session_id}/start").json()
        question = started["questions"][-1]
        assert "Product Manager" in question["text"]
        result = client.post(
            f"/api/interviews/{session_id}/answers",
            json={"question_id": question["id"], "text": detailed_answer()},
        )
        assert result.status_code == 200
        assert result.json()["next_action"] == "next_question"
        assert result.json()["session"]["questions"][-1]["kind"] == "primary"

        completed = client.post(f"/api/interviews/{session_id}/complete").json()
        assert completed["status"] == "completed"
        report = client.get(f"/api/interviews/{session_id}/report").json()
        assert 0 <= report["overall_score"] <= 100
        assert len(report["scores"]) == 7
        assert report["questions"][0]["answer"]["type"] == "original"

        revision = client.post(
            f"/api/answers/{question['id']}/revision",
            json={"text": detailed_answer() + " I reviewed the outcome with the team."},
        )
        assert revision.status_code == 200
        saved = client.get(f"/api/interviews/{session_id}").json()
        assert saved["questions"][0]["revisions"][0]["type"] == "revision"


def test_short_answer_gets_targeted_follow_up(tmp_path, monkeypatch):
    with make_client(tmp_path, monkeypatch) as client:
        created = client.post(
            "/api/interviews",
            json={"role": "Designer", "duration_minutes": 15},
        ).json()
        session = client.post(f"/api/interviews/{created['id']}/start").json()
        primary = session["questions"][-1]

        result = client.post(
            f"/api/interviews/{created['id']}/answers",
            json={"question_id": primary["id"], "text": "I had a difficult project."},
        )
        assert result.status_code == 200
        assert result.json()["next_action"] == "follow_up"
        assert result.json()["follow_up"]["kind"] == "follow_up"

        follow_up = result.json()["follow_up"]
        second = client.post(
            f"/api/interviews/{created['id']}/answers",
            json={"question_id": follow_up["id"], "text": detailed_answer()},
        )
        assert second.status_code == 200
        assert second.json()["next_action"] == "next_question"
        assert second.json()["session"]["questions"][-1]["kind"] == "primary"


def test_answer_validation_and_session_ownership_state(tmp_path, monkeypatch):
    with make_client(tmp_path, monkeypatch) as client:
        created = client.post(
            "/api/interviews",
            json={"role": "Analyst", "duration_minutes": 15},
        ).json()
        session_id = created["id"]
        draft_question = "not-a-question"
        not_started = client.post(
            f"/api/interviews/{session_id}/answers",
            json={"question_id": draft_question, "text": "An answer."},
        )
        assert not_started.status_code == 409

        started = client.post(f"/api/interviews/{session_id}/start").json()
        question_id = started["questions"][-1]["id"]
        blank = client.post(
            f"/api/interviews/{session_id}/answers",
            json={"question_id": question_id, "text": "   "},
        )
        assert blank.status_code == 422
        wrong_question = client.post(
            f"/api/interviews/{session_id}/answers",
            json={"question_id": draft_question, "text": "This is a valid length answer."},
        )
        assert wrong_question.status_code == 409


def test_follow_ups_are_distinct_and_capped_per_primary_question(tmp_path, monkeypatch):
    with make_client(tmp_path, monkeypatch) as client:
        created = client.post(
            "/api/interviews",
            json={"role": "Engineer", "duration_minutes": 15},
        ).json()
        session_id = created["id"]
        session = client.post(f"/api/interviews/{session_id}/start").json()
        question = session["questions"][-1]

        actions = []
        for _ in range(4):
            result = client.post(
                f"/api/interviews/{session_id}/answers",
                json={"question_id": question["id"], "text": "I don't know."},
            )
            assert result.status_code == 200
            actions.append(result.json()["next_action"])
            session = result.json()["session"]
            question = session["questions"][-1]

        follow_ups = [
            item for item in session["questions"]
            if item["kind"] == "follow_up"
        ]
        assert actions == ["follow_up", "follow_up", "follow_up", "next_question"]
        assert len(follow_ups) == main.MAX_FOLLOW_UPS
        assert len({item["text"] for item in follow_ups}) == len(follow_ups)


def test_openrouter_flow_generates_question_feedback_and_follow_up(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "OPENROUTER_API_KEY", "test-key")
    monkeypatch.setattr(main, "OPENROUTER_MODEL", "test/model")
    responses = [
        {"text": "Describe a challenging project you led.", "competency": "Leadership"},
        ai_evaluation(["result"]),
        {"text": "What changed because of the actions you took?"},
        ai_evaluation(),
    ]
    prompts = []

    async def mock_openrouter_json(system_prompt, user_prompt):
        prompts.append(user_prompt)
        return responses.pop(0)

    monkeypatch.setattr(main, "openrouter_json", mock_openrouter_json)
    with make_client(tmp_path, monkeypatch) as client:
        session = client.post(
            "/api/interviews",
            json={"role": "Engineer", "duration_minutes": 15, "ai_consent": True},
        ).json()
        started = client.post(f"/api/interviews/{session['id']}/start")
        assert started.status_code == 200
        question = started.json()["questions"][-1]

        result = client.post(
            f"/api/interviews/{session['id']}/answers",
            json={"question_id": question["id"], "text": detailed_answer()},
        )
        assert result.status_code == 200
        data = result.json()
        assert data["next_action"] == "follow_up"
        assert data["evaluation"]["evaluator"] == "OpenRouter · test/model"
        assert data["follow_up"]["text"] == "What changed because of the actions you took?"
        revision_text = detailed_answer() + " I reviewed the outcome with the team."
        revision = client.post(
            f"/api/answers/{question['id']}/revision",
            json={"text": revision_text},
        )
        assert revision.status_code == 200
        assert revision.json()["evaluation"]["evaluator"] == "OpenRouter · test/model"
        assert len(prompts) == 4
        assert "Engineer" in prompts[0]
        assert detailed_answer() in prompts[1]
        assert revision_text in prompts[3]


def test_openrouter_failure_keeps_answer_and_allows_idempotent_retry(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "OPENROUTER_API_KEY", "test-key")
    responses = [
        {"text": "Describe a difficult project.", "competency": "Problem-solving"},
        main.AIServiceError("The AI coach is temporarily unavailable."),
        ai_evaluation(),
        {"text": "Tell me about another project where you adapted to change.", "competency": "Adaptability"},
    ]

    async def mock_openrouter_json(_system_prompt, _user_prompt):
        response = responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response

    monkeypatch.setattr(main, "openrouter_json", mock_openrouter_json)
    with make_client(tmp_path, monkeypatch) as client:
        session = client.post(
            "/api/interviews",
            json={"role": "Engineer", "duration_minutes": 15, "ai_consent": True},
        ).json()
        started = client.post(f"/api/interviews/{session['id']}/start").json()
        question = started["questions"][-1]
        answer_payload = {"question_id": question["id"], "text": detailed_answer()}

        failed = client.post(f"/api/interviews/{session['id']}/answers", json=answer_payload)
        assert failed.status_code == 503
        saved = client.get(f"/api/interviews/{session['id']}").json()
        assert saved["questions"][-1]["answer"]["text"] == detailed_answer()
        assert saved["questions"][-1]["evaluation"] is None

        premature_completion = client.post(f"/api/interviews/{session['id']}/complete")
        assert premature_completion.status_code == 409

        retried = client.post(f"/api/interviews/{session['id']}/answers", json=answer_payload)
        assert retried.status_code == 200
        assert retried.json()["next_action"] == "next_question"
        assert retried.json()["session"]["continuation_pending"] is False
        assert retried.json()["session"]["questions"][0]["answer"]["text"] == detailed_answer()


def test_openrouter_requires_opt_in_and_reports_local_fallback(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "OPENROUTER_API_KEY", "test-key")

    async def unexpected_openrouter_call(_system_prompt, _user_prompt):
        pytest.fail("OpenRouter must not be called for a session without consent.")

    monkeypatch.setattr(main, "openrouter_json", unexpected_openrouter_call)
    with make_client(tmp_path, monkeypatch) as client:
        assert client.get("/api/health").json()["coach"] == "openrouter"
        session = client.post(
            "/api/interviews",
            json={"role": "Designer", "duration_minutes": 15, "ai_consent": False},
        ).json()
        started = client.post(f"/api/interviews/{session['id']}/start").json()
        question = started["questions"][-1]
        result = client.post(
            f"/api/interviews/{session['id']}/answers",
            json={"question_id": question["id"], "text": detailed_answer()},
        )
        assert result.status_code == 200
        assert result.json()["evaluation"]["evaluator"] == "Local prototype evaluator"


@pytest.mark.anyio
async def test_openrouter_evidence_must_quote_the_latest_answer(monkeypatch):
    monkeypatch.setattr(main, "OPENROUTER_API_KEY", "test-key")
    invalid = ai_evaluation()
    invalid["dimensions"][0]["evidence"] = "A quote that was never said."

    async def mock_openrouter_json(_system_prompt, _user_prompt):
        return invalid

    monkeypatch.setattr(main, "openrouter_json", mock_openrouter_json)
    session = {
        "config": {
            "ai_consent": True,
            "role": "Engineer",
            "interview_type": "Behavioral",
            "difficulty": "Intermediate",
            "focus_competency": "Mixed",
        }
    }
    question = {"text": "Describe a challenging project."}
    with pytest.raises(main.AIServiceError, match="exact quote"):
        await main.evaluate_response("I delivered the project.", question, session, ["I delivered the project."])


@pytest.mark.anyio
@pytest.mark.parametrize(
    "content",
    [
        '{"text":"A valid generated question.","competency":"Problem-solving"}',
        '```json\n{"text":"A valid generated question.","competency":"Problem-solving"}\n```',
        'Here is the requested JSON:\n{"text":"A valid generated question.","competency":"Problem-solving"}',
        [
            {"type": "text", "text": '{"text":"A valid generated question.",'},
            {"type": "text", "text": '"competency":"Problem-solving"}'},
        ],
    ],
)
async def test_openrouter_json_parses_supported_content_formats(monkeypatch, content):
    monkeypatch.setattr(main, "OPENROUTER_API_KEY", "test-key")
    response_body = {"choices": [{"message": {"content": content}, "finish_reason": "stop"}]}
    transport = httpx.MockTransport(lambda _request: httpx.Response(200, json=response_body))
    original_client = httpx.AsyncClient

    def mock_async_client(*, timeout):
        return original_client(timeout=timeout, transport=transport)

    monkeypatch.setattr(main.httpx, "AsyncClient", mock_async_client)
    result = await main.openrouter_json("system", "user")
    assert result == {"text": "A valid generated question.", "competency": "Problem-solving"}


@pytest.mark.anyio
async def test_openrouter_json_accepts_preparsed_structured_content(monkeypatch):
    monkeypatch.setattr(main, "OPENROUTER_API_KEY", "test-key")
    response_body = {
        "choices": [
            {
                "message": {
                    "content": None,
                    "parsed": {"text": "A valid generated question.", "competency": "Problem-solving"},
                },
                "finish_reason": "stop",
            }
        ]
    }
    transport = httpx.MockTransport(lambda _request: httpx.Response(200, json=response_body))
    original_client = httpx.AsyncClient

    def mock_async_client(*, timeout):
        return original_client(timeout=timeout, transport=transport)

    monkeypatch.setattr(main.httpx, "AsyncClient", mock_async_client)
    result = await main.openrouter_json("system", "user")
    assert result == {"text": "A valid generated question.", "competency": "Problem-solving"}


@pytest.mark.anyio
async def test_openrouter_request_caps_reasoning_for_complete_json(monkeypatch):
    monkeypatch.setattr(main, "OPENROUTER_API_KEY", "test-key")
    request_payload = {}

    def respond(request):
        request_payload.update(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {"content": '{"ok":true}'},
                        "finish_reason": "stop",
                    }
                ]
            },
        )

    transport = httpx.MockTransport(respond)
    original_client = httpx.AsyncClient

    def mock_async_client(*, timeout):
        return original_client(timeout=timeout, transport=transport)

    monkeypatch.setattr(main.httpx, "AsyncClient", mock_async_client)
    assert await main.openrouter_json("system", "user") == {"ok": True}
    assert request_payload["max_tokens"] == 4096
    assert request_payload["reasoning"] == {"effort": "low"}


@pytest.mark.anyio
async def test_openrouter_json_reports_truncated_content_without_exposing_provider_body(monkeypatch):
    monkeypatch.setattr(main, "OPENROUTER_API_KEY", "test-key")
    transport = httpx.MockTransport(
        lambda _request: httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {"content": '{"incomplete":'},
                        "finish_reason": "length",
                    }
                ]
            },
        )
    )
    original_client = httpx.AsyncClient

    def mock_async_client(*, timeout):
        return original_client(timeout=timeout, transport=transport)

    monkeypatch.setattr(main.httpx, "AsyncClient", mock_async_client)
    with pytest.raises(main.AIServiceError, match="cut short"):
        await main.openrouter_json("system", "user")


@pytest.mark.anyio
async def test_openrouter_json_rejects_non_json_content(monkeypatch):
    monkeypatch.setattr(main, "OPENROUTER_API_KEY", "test-key")
    transport = httpx.MockTransport(
        lambda _request: httpx.Response(
            200,
            json={"choices": [{"message": {"content": "The answer is 42."}, "finish_reason": "stop"}]},
        )
    )
    original_client = httpx.AsyncClient

    def mock_async_client(*, timeout):
        return original_client(timeout=timeout, transport=transport)

    monkeypatch.setattr(main.httpx, "AsyncClient", mock_async_client)
    with pytest.raises(main.AIServiceError, match="invalid JSON"):
        await main.openrouter_json("system", "user")


@pytest.mark.anyio
async def test_openrouter_insufficient_credits_error_is_actionable(monkeypatch):
    monkeypatch.setattr(main, "OPENROUTER_API_KEY", "test-key")
    transport = httpx.MockTransport(
        lambda _request: httpx.Response(
            402,
            json={"error": {"code": 402, "message": "Insufficient credits"}},
        )
    )
    original_client = httpx.AsyncClient

    def mock_async_client(*, timeout):
        return original_client(timeout=timeout, transport=transport)

    monkeypatch.setattr(main.httpx, "AsyncClient", mock_async_client)
    with pytest.raises(main.AIServiceError, match="Add credits or check the key's spending limit"):
        await main.openrouter_json("system", "user")


def test_technical_interview_uses_its_own_questions_rubric_and_report(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "OPENROUTER_API_KEY", "")
    with make_client(tmp_path, monkeypatch) as client:
        created = client.post(
            "/api/interviews",
            json={
                "role": "Backend Engineer",
                "interview_type": "Technical",
                "focus_competency": "System design",
                "duration_minutes": 15,
            },
        )
        assert created.status_code == 201
        session_id = created.json()["id"]
        started = client.post(f"/api/interviews/{session_id}/start").json()
        question = started["questions"][-1]
        assert question["competency"] == "System design"
        assert "system design" in question["text"].lower()

        answer = (
            "First I would clarify the availability and throughput requirements. I would use a "
            "queue because it separates ingestion from processing. For large traffic, the time "
            "complexity is linear in the number of events and the service can scale horizontally. "
            "A database index reduces lookup latency but costs storage. I would test duplicate "
            "events, empty inputs, timeouts, and recovery after worker failure."
        )
        result = client.post(
            f"/api/interviews/{session_id}/answers",
            json={"question_id": question["id"], "text": answer},
        )
        assert result.status_code == 200
        assert result.json()["evaluation"]["rubric_version"] == "technical-v1"
        assert {item["key"] for item in result.json()["evaluation"]["scores"]} == {
            item["key"] for item in main.TECHNICAL_DIMENSIONS
        }
        assert result.json()["evaluation"]["evaluator"].startswith("Local technical-structure")

        completed = client.post(f"/api/interviews/{session_id}/complete")
        assert completed.status_code == 200
        report = client.get(f"/api/interviews/{session_id}/report").json()
        assert "technical question" in report["summary"]
        assert report["rubric_version"] == "technical-v1"
        assert len(report["scores"]) == len(main.TECHNICAL_DIMENSIONS)
        revision = client.post(
            f"/api/answers/{question['id']}/revision",
            json={"text": answer + " I would also monitor queue depth."},
        )
        assert revision.status_code == 200
        assert revision.json()["evaluation"]["rubric_version"] == "technical-v1"


def test_technical_interview_rejects_behavioral_focus(tmp_path, monkeypatch):
    with make_client(tmp_path, monkeypatch) as client:
        response = client.post(
            "/api/interviews",
            json={
                "role": "Engineer",
                "interview_type": "Technical",
                "focus_competency": "Collaboration",
            },
        )
        assert response.status_code == 422


def test_technical_interview_can_report_when_all_questions_are_skipped(tmp_path, monkeypatch):
    with make_client(tmp_path, monkeypatch) as client:
        session = client.post(
            "/api/interviews",
            json={"role": "Engineer", "interview_type": "Technical", "duration_minutes": 15},
        ).json()
        started = client.post(f"/api/interviews/{session['id']}/start")
        assert started.status_code == 200
        skipped = client.post(f"/api/interviews/{session['id']}/skip")
        assert skipped.status_code == 200
        completed = client.post(f"/api/interviews/{session['id']}/complete")
        assert completed.status_code == 200
        report = client.get(f"/api/interviews/{session['id']}/report")
        assert report.status_code == 200
        assert report.json()["rubric_version"] == "technical-v1"
        assert report.json()["priority"] == "—"
        assert report.json()["scores"] == []


def test_progress_does_not_average_behavioral_and_technical_scores_together(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "OPENROUTER_API_KEY", "")
    with make_client(tmp_path, monkeypatch) as client:
        for interview_type, focus in (("Behavioral", "Mixed"), ("Technical", "System design")):
            session = client.post(
                "/api/interviews",
                json={
                    "role": "Engineer",
                    "interview_type": interview_type,
                    "focus_competency": focus,
                    "duration_minutes": 15,
                },
            ).json()
            started = client.post(f"/api/interviews/{session['id']}/start").json()
            question = started["questions"][-1]
            result = client.post(
                f"/api/interviews/{session['id']}/answers",
                json={"question_id": question["id"], "text": "First I would clarify the inputs because requirements affect the design. I would test boundary cases and compare the trade-offs."},
            )
            assert result.status_code == 200
            assert client.post(f"/api/interviews/{session['id']}/complete").status_code == 200

        progress = client.get("/api/progress").json()
        assert progress["completed_count"] == 2
        assert progress["average_score"] is None
        assert progress["interview_types"] == ["Behavioral", "Technical"]
        assert "separate rubrics" in progress["comparison_note"].lower()


def test_openrouter_technical_mode_uses_technical_rubric(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "OPENROUTER_API_KEY", "test-key")
    responses = [
        {"text": "How would you design a rate-limited API?", "competency": "APIs & backend"},
        ai_technical_evaluation(["testing"]),
        {"text": "How would you test this API under partial dependency failure?", "competency": "Testing"},
        {"text": "How would you model data for a high-volume API?", "competency": "Databases"},
    ]
    prompts = []
    system_prompts = []

    async def mock_openrouter_json(system_prompt, user_prompt):
        system_prompts.append(system_prompt)
        prompts.append(user_prompt)
        return responses.pop(0)

    monkeypatch.setattr(main, "openrouter_json", mock_openrouter_json)
    with make_client(tmp_path, monkeypatch) as client:
        session = client.post(
            "/api/interviews",
            json={
                "role": "Backend Engineer",
                "interview_type": "Technical",
                "focus_competency": "APIs & backend",
                "duration_minutes": 15,
                "ai_consent": True,
            },
        ).json()
        started = client.post(f"/api/interviews/{session['id']}/start")
        assert started.status_code == 200
        question = started.json()["questions"][-1]
        answer = "I would use a token bucket because it allows bursts and limits average request rates. First I would store token state per client and test boundary rates."
        result = client.post(
            f"/api/interviews/{session['id']}/answers",
            json={"question_id": question["id"], "text": answer},
        )
        assert result.status_code == 200
        assert result.json()["next_action"] == "follow_up"
        assert result.json()["evaluation"]["rubric_version"] == "technical-v1"
        assert len(result.json()["evaluation"]["scores"]) == len(main.TECHNICAL_DIMENSIONS)
        assert "technical interview-practice coach" in system_prompts[1]
        evaluation_prompt = json.loads(prompts[1])
        assert evaluation_prompt["rubric_version"] == "technical-v1"
        assert {dimension["key"] for dimension in evaluation_prompt["dimensions"]} == {
            item["key"] for item in main.TECHNICAL_DIMENSIONS
        }


def test_sessions_are_isolated_by_authenticated_user(tmp_path, monkeypatch):
    with make_client(tmp_path, monkeypatch, "candidate-one") as first_client:
        created = first_client.post(
            "/api/interviews",
            json={"role": "Engineer", "duration_minutes": 15},
        ).json()

    main.app.dependency_overrides[main.require_user] = lambda: {"id": "candidate-two"}
    with TestClient(main.app) as second_client:
        assert second_client.get("/api/interviews").json() == []
        assert second_client.get(f"/api/interviews/{created['id']}").status_code == 404


def test_business_api_requires_supabase_configuration(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DB_PATH", tmp_path / "interviewiq-test.sqlite3")
    main.initialize_database()
    main.app.dependency_overrides.pop(main.require_user, None)
    monkeypatch.setattr(main, "SUPABASE_URL", "")
    monkeypatch.setattr(main, "SUPABASE_ANON_KEY", "")
    with TestClient(main.app) as client:
        response = client.get("/api/profile")
        assert response.status_code == 503
        assert "not configured" in response.json()["detail"].lower()


def test_vite_project_port_is_allowed_by_cors(tmp_path, monkeypatch):
    with make_client(tmp_path, monkeypatch) as client:
        response = client.options(
            "/api/profile",
            headers={
                "Origin": "http://127.0.0.1:5187",
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "authorization",
            },
        )
        assert response.status_code == 200
        assert response.headers["access-control-allow-origin"] == "http://127.0.0.1:5187"


@pytest.mark.anyio
async def test_supabase_authentication_resolves_identity_from_verified_user_endpoint(monkeypatch):
    monkeypatch.setattr(main, "SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setattr(main, "SUPABASE_ANON_KEY", "public-test-key")
    transport = httpx.MockTransport(
        lambda request: httpx.Response(200, json={"id": "verified-candidate"})
    )
    original_client = httpx.AsyncClient

    def mock_async_client(*, timeout):
        return original_client(timeout=timeout, transport=transport)

    monkeypatch.setattr(main.httpx, "AsyncClient", mock_async_client)
    identity = await main.require_user("Bearer valid-test-token")
    assert identity == {"id": "verified-candidate"}


@pytest.mark.anyio
async def test_supabase_authentication_rejects_invalid_access_token(monkeypatch):
    monkeypatch.setattr(main, "SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setattr(main, "SUPABASE_ANON_KEY", "public-test-key")
    transport = httpx.MockTransport(
        lambda request: httpx.Response(401, json={"message": "invalid token"})
    )
    original_client = httpx.AsyncClient

    def mock_async_client(*, timeout):
        return original_client(timeout=timeout, transport=transport)

    monkeypatch.setattr(main.httpx, "AsyncClient", mock_async_client)
    with pytest.raises(main.HTTPException) as error:
        await main.require_user("Bearer invalid-test-token")
    assert error.value.status_code == 401


@pytest.mark.anyio
async def test_supabase_authentication_requires_a_bearer_token(monkeypatch):
    monkeypatch.setattr(main, "SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setattr(main, "SUPABASE_ANON_KEY", "public-test-key")
    with pytest.raises(main.HTTPException) as error:
        await main.require_user(None)
    assert error.value.status_code == 401
