"""Compare /play/ header (game overlay chrome) on prod vs local."""


def _enter_game(page, base_url):
    page.goto(f"{base_url}/")
    page.wait_for_load_state("networkidle")
    # Click the Play Now row/button to embed the game iframe
    page.locator(".demo-row").first.click()
    # Give the iframe + PlayOverlay a moment
    page.wait_for_timeout(3000)


def test_play_header_prod(browser, results_dir):
    context = browser.new_context(viewport={"width": 1280, "height": 960})
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(f"[pageerror] {e}"))
    page.on("console", lambda m: (m.type == "error") and errors.append(f"[console error] {m.text}"))
    failed_reqs = []
    page.on("requestfailed", lambda r: failed_reqs.append(f"{r.method} {r.url} -> {r.failure}"))

    try:
        _enter_game(page, "https://allbyte.studio")
        page.screenshot(path=str(results_dir / "play-prod.png"), full_page=False)

        # Inspect the overlay header specifically
        overlay = page.locator(".play-overlay-header")
        print(f"\n[prod] overlay count: {overlay.count()}")
        if overlay.count() > 0:
            box = overlay.bounding_box()
            print(f"[prod] overlay bounding box: {box}")
            overlay.screenshot(path=str(results_dir / "play-prod-overlay.png"))
        else:
            print("[prod] NO .play-overlay-header found")

        print("\n[prod] console/page errors:")
        for e in errors[:30]:
            print(f"  {e}")
        print("\n[prod] failed requests:")
        for r in failed_reqs[:30]:
            print(f"  {r}")
    finally:
        context.close()


def test_play_header_local(browser, results_dir):
    context = browser.new_context(viewport={"width": 1280, "height": 960})
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(f"[pageerror] {e}"))
    page.on("console", lambda m: (m.type == "error") and errors.append(f"[console error] {m.text}"))
    failed_reqs = []
    page.on("requestfailed", lambda r: failed_reqs.append(f"{r.method} {r.url} -> {r.failure}"))

    try:
        _enter_game(page, "http://localhost:4321")
        page.screenshot(path=str(results_dir / "play-local.png"), full_page=False)

        overlay = page.locator(".play-overlay-header")
        print(f"\n[local] overlay count: {overlay.count()}")
        if overlay.count() > 0:
            box = overlay.bounding_box()
            print(f"[local] overlay bounding box: {box}")
            overlay.screenshot(path=str(results_dir / "play-local-overlay.png"))

        print("\n[local] console/page errors:")
        for e in errors[:30]:
            print(f"  {e}")
        print("\n[local] failed requests:")
        for r in failed_reqs[:30]:
            print(f"  {r}")
    finally:
        context.close()
