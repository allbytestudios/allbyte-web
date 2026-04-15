"""Smoke test the unified Owner Questions page rendering Arc's sample file."""


def test_questions_renders_all_sample_entries(page, base_url):
    page.goto(f"{base_url}/test/decisions/")
    page.wait_for_load_state("networkidle")
    page.wait_for_selector(".question-card", timeout=10000)

    cards = page.locator(".question-card")
    count = cards.count()
    print(f"\n[owner-questions] rendered {count} cards")
    assert count == 8, f"expected 8 sample entries rendered, got {count}"

    # Check source badges represent all 4 source types present in sample
    sources = set()
    for i in range(count):
        src = cards.nth(i).locator(".q-source").inner_text().strip().lower()
        sources.add(src)
    print(f"[owner-questions] source types: {sources}")
    assert "verify" in sources, "missing verification source badge"
    assert "ticket" in sources, "missing ticket source badge"
    assert "decision" in sources, "missing decision source badge"
    assert "blocker" in sources, "missing blocker source badge"

    # Verify priority sort: P0 should be first
    first_priority = cards.first.locator(".q-priority").inner_text().strip()
    assert first_priority == "P0", f"expected P0 first, got {first_priority}"

    # Choice entry renders buttons (not textarea)
    oq7 = page.locator(".question-card:has-text('OQ-7')")
    assert oq7.count() == 1
    choice_btns = oq7.locator(".q-btn-choice")
    assert choice_btns.count() == 2, "OQ-7 should have 2 choice buttons"
    rec_btn = oq7.locator(".q-btn-recommended")
    assert rec_btn.count() == 1, "OQ-7 should have exactly 1 recommended button"

    # Verification entry renders Verified + Found issue buttons
    oq1 = page.locator(".question-card:has-text('OQ-1')")
    assert oq1.count() == 1
    assert oq1.locator(".q-btn-verified").count() == 1
    assert oq1.locator(".q-btn-issue").count() == 1

    # FreeText entry renders a textarea
    oq8 = page.locator(".question-card:has-text('OQ-8')")
    assert oq8.count() == 1
    assert oq8.locator("textarea").count() == 1

    # Related artifacts render for OQ-1
    artifacts = oq1.locator(".q-artifact")
    assert artifacts.count() == 2, f"OQ-1 should have 2 artifacts, got {artifacts.count()}"

    # Header counts
    hint = page.locator(".queue-hint").inner_text()
    print(f"[owner-questions] queue hint: {hint}")
    assert "1 decision" in hint.lower()
    assert "6 verifications" in hint.lower() or "6 verification" in hint.lower()
    assert "1 open" in hint.lower()

    page.screenshot(path="tests/e2e/test_results/owner-questions-page.png", full_page=True)
