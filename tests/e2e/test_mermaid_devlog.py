"""Quick check that the Mermaid diagram in two-claudes-to-five renders."""
import pytest


def test_mermaid_renders(page):
    console_msgs = []
    page.on("console", lambda m: console_msgs.append(f"[{m.type}] {m.text}"))
    page.on("pageerror", lambda e: console_msgs.append(f"[pageerror] {e}"))

    page.goto("http://localhost:4321/devlog/two-claudes-to-five/")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(3000)

    raw = page.locator("pre code.language-mermaid").count()
    rendered = page.locator(".mermaid-diagram").count()
    print(f"\n[mermaid] rendered: {rendered}, raw pre blocks remaining: {raw}")

    print("\n--- console ---")
    for m in console_msgs:
        print(m)
    print("--- end console ---")

    if rendered:
        page.locator(".mermaid-diagram").first.screenshot(
            path="tests/e2e/test_results/mermaid-diagram.png"
        )
    else:
        page.screenshot(path="tests/e2e/test_results/mermaid-fail-fullpage.png", full_page=True)
