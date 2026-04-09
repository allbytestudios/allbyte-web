"""
Pytest fixtures for allbyte-web E2E tests.
Provides browser automation, API mocking, and screenshot-on-failure.
"""
import os
import time
from pathlib import Path

import pytest
from playwright.sync_api import sync_playwright


# === Config ===

BASE_URL = os.environ.get("BASE_URL", "http://localhost:4321")
RESULTS_DIR = Path(os.environ.get("RESULTS_DIR", "tests/e2e/test_results"))


# === CLI Options ===

def pytest_addoption(parser):
    parser.addoption("--headed", action="store_true", help="Show browser window")


# === Fixtures ===

@pytest.fixture(scope="session")
def base_url():
    return BASE_URL


@pytest.fixture(scope="session")
def results_dir():
    d = RESULTS_DIR
    d.mkdir(parents=True, exist_ok=True)
    return d


@pytest.fixture(scope="session")
def browser(request):
    """Launch Playwright Chromium for the session."""
    headed = request.config.getoption("--headed")
    # Default to headed mode if DISPLAY is set (Docker with noVNC)
    if not headed and os.environ.get("DISPLAY"):
        headed = True
    pw = sync_playwright().start()
    b = pw.chromium.launch(
        headless=not headed,
        args=["--disable-dev-shm-usage"],
    )
    yield b
    b.close()
    pw.stop()


@pytest.fixture(scope="function")
def page(browser, base_url):
    """Fresh page for each test."""
    context = browser.new_context(viewport={"width": 1280, "height": 960})
    p = context.new_page()
    yield p
    context.close()


@pytest.fixture
def mock_api(page):
    """Intercept API calls to Lambda backend with mock responses."""
    API_BASE = "https://wj3xkrm1r1.execute-api.us-east-1.amazonaws.com"

    def handle_route(route):
        url = route.request.url
        if "/auth/me" in url:
            route.fulfill(
                status=200,
                content_type="application/json",
                body='{"user":{"userId":"test-user","email":"test@allbyte.studio","username":"tester","tier":"hero","stripeCustomerId":"cus_test"}}',
            )
        elif "/auth/login" in url:
            route.fulfill(
                status=200,
                content_type="application/json",
                body='{"token":"mock-jwt-token","user":{"userId":"test-user","email":"test@allbyte.studio","username":"tester","tier":"hero"}}',
            )
        elif "/auth/signup" in url:
            route.fulfill(
                status=200,
                content_type="application/json",
                body='{"token":"mock-jwt-token","user":{"userId":"new-user","email":"new@allbyte.studio","username":"newuser","tier":null}}',
            )
        elif "/checkout" in url:
            route.fulfill(
                status=200,
                content_type="application/json",
                body='{"url":"https://checkout.stripe.com/mock-session"}',
            )
        elif "/counts" in url:
            route.fulfill(
                status=200,
                content_type="application/json",
                body='{"initiate":5,"hero":3,"legend":1}',
            )
        elif "/auth/oauth/" in url:
            route.fulfill(status=302, headers={"Location": "/"})
        else:
            route.continue_()

    page.route(f"{API_BASE}/**", handle_route)
    yield


# === Hooks ===

@pytest.hookimpl(tryfirst=True, hookwrapper=True)
def pytest_runtest_makereport(item, call):
    """Store test result on the item for fixture to check."""
    outcome = yield
    rep = outcome.get_result()
    setattr(item, f"rep_{rep.when}", rep)


@pytest.fixture(autouse=True)
def _screenshot_on_failure(request, results_dir):
    """Automatically screenshot on test failure."""
    yield
    if hasattr(request.node, "rep_call") and request.node.rep_call.failed:
        page = request.node.funcargs.get("page")
        if page:
            try:
                path = results_dir / f"FAIL_{request.node.name}.png"
                page.screenshot(path=str(path))
            except Exception:
                pass
