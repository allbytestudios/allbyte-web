"""E2E: click a verification button and confirm it POSTs the right payload."""
import json


def test_verification_submit_hits_api(page, base_url):
    """Mock /api/answers to capture the payload without polluting the real ndjson."""
    captured = {}

    def capture(route):
        req = route.request
        captured["method"] = req.method
        try:
            captured["body"] = req.post_data_json
        except Exception:
            captured["body"] = req.post_data
        route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps({"ok": True, "questionId": "OQ-1", "answerType": "verification"}),
        )

    page.route("**/api/answers/", capture)

    page.goto(f"{base_url}/test/decisions/")
    page.wait_for_load_state("networkidle")
    page.wait_for_selector(".question-card", timeout=10000)

    # Click the ✓ Verified button on OQ-2 (highest priority, P0 Slime)
    oq2 = page.locator(".question-card:has-text('OQ-2')")
    oq2.locator(".q-btn-verified").click()
    page.wait_for_timeout(500)

    assert captured.get("method") == "POST"
    body = captured["body"]
    if isinstance(body, str):
        body = json.loads(body)
    assert body["questionId"] == "OQ-2"
    assert body["answerType"] == "verification"
    assert body["verified"] is True


def test_choice_submit_hits_api(page, base_url):
    captured = {}

    def capture(route):
        req = route.request
        try:
            captured["body"] = req.post_data_json
        except Exception:
            captured["body"] = req.post_data
        route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps({"ok": True}),
        )

    page.route("**/api/answers/", capture)

    page.goto(f"{base_url}/test/decisions/")
    page.wait_for_load_state("networkidle")
    page.wait_for_selector(".question-card", timeout=10000)

    oq7 = page.locator(".question-card:has-text('OQ-7')")
    # Click the first (non-recommended) option to prove UI can choose any option
    oq7.locator(".q-btn-choice").first.click()
    page.wait_for_timeout(500)

    body = captured.get("body")
    if isinstance(body, str):
        body = json.loads(body)
    assert body["questionId"] == "OQ-7"
    assert body["answerType"] == "choice"
    assert body["choice"] == "Keep — works on web via Fullscreen API"


def test_freetext_submit_hits_api(page, base_url):
    captured = {}

    def capture(route):
        req = route.request
        try:
            captured["body"] = req.post_data_json
        except Exception:
            captured["body"] = req.post_data
        route.fulfill(status=200, content_type="application/json", body='{"ok":true}')

    page.route("**/api/answers/", capture)

    page.goto(f"{base_url}/test/decisions/")
    page.wait_for_load_state("networkidle")
    page.wait_for_selector(".question-card", timeout=10000)

    oq8 = page.locator(".question-card:has-text('OQ-8')")
    oq8.locator("textarea").fill("Ship it, looks good.")
    oq8.locator(".q-btn-send").click()
    page.wait_for_timeout(500)

    body = captured.get("body")
    if isinstance(body, str):
        body = json.loads(body)
    assert body["questionId"] == "OQ-8"
    assert body["answerType"] == "freeText"
    assert body["freeText"] == "Ship it, looks good."


def test_issue_note_expands_and_submits(page, base_url):
    captured = {}

    def capture(route):
        req = route.request
        try:
            captured["body"] = req.post_data_json
        except Exception:
            captured["body"] = req.post_data
        route.fulfill(status=200, content_type="application/json", body='{"ok":true}')

    page.route("**/api/answers/", capture)

    page.goto(f"{base_url}/test/decisions/")
    page.wait_for_load_state("networkidle")
    page.wait_for_selector(".question-card", timeout=10000)

    oq3 = page.locator(".question-card:has-text('OQ-3')")
    # Click "Found issue"
    oq3.locator(".q-btn-issue").click()
    # Textarea should appear
    textarea = oq3.locator(".q-issue-note textarea")
    textarea.wait_for(state="visible", timeout=2000)
    textarea.fill("Cursor stuck on Music Volume row, Down didn't jump to SFX")
    oq3.locator(".q-btn-issue-submit").click()
    page.wait_for_timeout(500)

    body = captured.get("body")
    if isinstance(body, str):
        body = json.loads(body)
    assert body["questionId"] == "OQ-3"
    assert body["answerType"] == "verification"
    assert body["verified"] is False
    assert "Music Volume" in body["issueNote"]
