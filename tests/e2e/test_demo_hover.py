"""Confirm the demo banner swaps to the GIF on hover."""


def test_demo_gif_swaps_on_hover(page, base_url):
    page.goto(f"{base_url}/")
    page.wait_for_load_state("networkidle")

    img = page.locator(".demo-gif")
    img.wait_for(state="visible")

    before = img.get_attribute("src")
    assert before is not None and "still.png" in before, (
        f"expected still png before hover, got {before!r}"
    )

    page.locator(".demo-row").hover()
    page.wait_for_timeout(300)

    after = img.get_attribute("src")
    assert after is not None and after.endswith(".gif"), (
        f"expected gif after hover, got {after!r}"
    )
