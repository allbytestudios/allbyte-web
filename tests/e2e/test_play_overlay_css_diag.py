"""Diagnose why /play/ overlay is unstyled on prod."""


def _enter_and_inspect(page, base_url, label):
    page.goto(f"{base_url}/")
    page.wait_for_load_state("networkidle")
    page.locator(".demo-row").first.click()
    page.wait_for_timeout(3000)

    print(f"\n===== {label} =====")

    # Full class list on the overlay header
    cls = page.evaluate(
        "document.querySelector('.play-overlay-header')?.className || 'NOT FOUND'"
    )
    print(f"overlay classes: {cls}")

    # Find all <style> tags and report which ones reference play-overlay
    style_hits = page.evaluate(
        """() => {
            const styles = Array.from(document.querySelectorAll('style'));
            return styles.map((s, i) => ({
                i,
                id: s.id || '',
                length: s.textContent.length,
                hasPlayOverlay: s.textContent.includes('play-overlay-header'),
                hasPlayBtn: s.textContent.includes('play-btn'),
                hasBtnLabel: s.textContent.includes('btn-label'),
                snippet: s.textContent.substring(0, 200)
            }));
        }"""
    )
    for s in style_hits:
        if s["hasPlayOverlay"] or s["hasPlayBtn"]:
            print(f"  style[{s['i']}] id={s['id']!r} len={s['length']} PLAYOVERLAY={s['hasPlayOverlay']} PLAYBTN={s['hasPlayBtn']}")

    # Computed style of the back button
    computed = page.evaluate(
        """() => {
            const btn = document.querySelector('.play-overlay-header .play-btn.back-btn');
            if (!btn) return 'NO BACK BUTTON';
            const cs = getComputedStyle(btn);
            return {
                display: cs.display,
                background: cs.backgroundColor,
                border: cs.border,
                padding: cs.padding,
                fontFamily: cs.fontFamily,
            };
        }"""
    )
    print(f"back-btn computed: {computed}")

    # Is the file input hidden?
    file_input = page.evaluate(
        """() => {
            const inp = document.querySelector('.play-overlay-header input[type=file]');
            if (!inp) return 'NO FILE INPUT';
            const cs = getComputedStyle(inp);
            return { display: cs.display, visibility: cs.visibility, width: cs.width, height: cs.height, cls: inp.className };
        }"""
    )
    print(f"file input: {file_input}")


def test_diag_prod(browser):
    context = browser.new_context(viewport={"width": 1280, "height": 960})
    page = context.new_page()
    try:
        _enter_and_inspect(page, "https://allbyte.studio", "PROD")
    finally:
        context.close()


def test_diag_local(browser):
    context = browser.new_context(viewport={"width": 1280, "height": 960})
    page = context.new_page()
    try:
        _enter_and_inspect(page, "http://localhost:4321", "LOCAL")
    finally:
        context.close()
