"""Visual + content check for the new 'What Your Donation Provides' section."""


def test_support_section(page, base_url):
    page.goto(f"{base_url}/subscribe/")
    page.wait_for_load_state("networkidle")

    section = page.locator(".support-section")
    assert section.count() == 1, f"expected 1 support section, got {section.count()}"

    title = section.locator(".support-title").inner_text()
    body = section.locator(".support-body").inner_text()
    assert title == "What Your Donation Provides", f"unexpected title: {title!r}"
    assert "porting the game" in body
    assert "donating or subscribing" in body

    # Order: tiers → support → donate → faq
    section_order = page.evaluate(
        """() => {
            const order = [];
            document.querySelectorAll('.tiers, .support-section, .donate-section, .faq-section').forEach(el => {
                order.push(el.className.split(' ')[0]);
            });
            return order;
        }"""
    )
    assert section_order == ["tiers", "support-section", "donate-section", "faq-section"], (
        f"unexpected layout order: {section_order}"
    )

    section.screenshot(path="tests/e2e/test_results/subscribe-support-section.png")
