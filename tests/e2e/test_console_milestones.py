"""Console page shows all three milestones, with Alpha + Beta flagged unscoped."""


def test_all_three_milestones_visible(page, base_url):
    page.goto(f"{base_url}/test/")
    page.wait_for_load_state("networkidle")
    page.wait_for_selector(".ms-card", timeout=5000)

    cards = page.locator(".ms-card")
    assert cards.count() == 3, f"expected 3 milestone cards, got {cards.count()}"

    names = [cards.nth(i).locator(".ms-name").inner_text().strip().lower() for i in range(3)]
    print(f"\n[milestones] order: {names}")
    assert names == ["pre alpha", "alpha", "beta"], f"unexpected order: {names}"


def test_pre_alpha_shows_percent_and_detail(page, base_url):
    page.goto(f"{base_url}/test/")
    page.wait_for_load_state("networkidle")
    page.wait_for_selector(".ms-card", timeout=5000)

    pre_alpha = page.locator(".ms-card").nth(0)
    # Not marked as unscoped
    assert "ms-card-unscoped" not in (pre_alpha.get_attribute("class") or "")
    # Shows a % value
    assert pre_alpha.locator(".ms-pct").count() == 1
    # No "not scoped yet" tag
    assert pre_alpha.locator(".ms-scope-tag").count() == 0


def test_alpha_beta_flagged_unscoped(page, base_url):
    page.goto(f"{base_url}/test/")
    page.wait_for_load_state("networkidle")
    page.wait_for_selector(".ms-card", timeout=5000)

    for idx in (1, 2):  # alpha, beta
        card = page.locator(".ms-card").nth(idx)
        cls = card.get_attribute("class") or ""
        assert "ms-card-unscoped" in cls, f"card {idx} not marked unscoped: {cls}"
        tag = card.locator(".ms-scope-tag").inner_text().strip().lower()
        assert "not scoped yet" in tag, f"card {idx} missing scope tag, got {tag!r}"
        # No % reading (would be misleading)
        assert card.locator(".ms-pct").count() == 0

    page.locator(".ms-progress").screenshot(
        path="tests/e2e/test_results/console-milestones.png"
    )
