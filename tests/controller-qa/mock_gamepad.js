// Mock Gamepad API for browser-level controller QA.
//
// This script is injected via Playwright's `addInitScript()` before any
// page scripts run. It overrides `navigator.getGamepads()` to return a
// configurable mock gamepad, and exposes helper functions on `window` for
// the Python harness to drive (install profile, press button, set axis,
// disconnect).
//
// The mock fires real `gamepadconnected` / `gamepaddisconnected` events
// so pages that listen for those (rather than polling) also see the
// transitions.

(function () {
  let mockGamepad = null;

  function buildGamepad(profile) {
    return {
      id: profile.id,
      index: 0,
      connected: true,
      mapping: profile.mapping || "standard",
      timestamp: performance.now(),
      buttons: Array.from({ length: profile.numButtons }, () => ({
        pressed: false,
        value: 0,
        touched: false,
      })),
      axes: Array.from({ length: profile.numAxes }, () => 0),
      vibrationActuator: null,
      // Custom: track which profile this is so the harness can introspect
      __qaProfileName: profile.name,
    };
  }

  // Override navigator.getGamepads to return our mock when active.
  // Preserve the real function for fallback if the harness disconnects.
  const realGetGamepads = navigator.getGamepads
    ? navigator.getGamepads.bind(navigator)
    : null;

  Object.defineProperty(navigator, "getGamepads", {
    value: function () {
      if (mockGamepad) {
        // Bump timestamp so polling consumers detect "freshness"
        mockGamepad.timestamp = performance.now();
        return [mockGamepad, null, null, null];
      }
      // No mock active — fall back to real (which on the test page is empty)
      return realGetGamepads ? realGetGamepads() : [null, null, null, null];
    },
    configurable: true,
    writable: true,
  });

  // ---- Harness API exposed on window for Playwright to call ----

  window.__qaInstallMock = function (profile) {
    const wasActive = mockGamepad !== null;
    mockGamepad = buildGamepad(profile);
    // Fire connectedevent on next tick so any page-side handlers register
    // it AFTER this function has returned and the page is in a steady state.
    setTimeout(() => {
      const ev = new Event("gamepadconnected");
      // GamepadEvent isn't constructible the same way across all engines;
      // attach gamepad as a property on the plain Event for max compat.
      ev.gamepad = mockGamepad;
      window.dispatchEvent(ev);
    }, 0);
    return { wasActive, id: profile.id };
  };

  window.__qaSetButton = function (index, pressed) {
    if (!mockGamepad) throw new Error("No mock gamepad installed");
    if (index < 0 || index >= mockGamepad.buttons.length) {
      throw new Error(
        `Button index ${index} out of range (0..${mockGamepad.buttons.length - 1})`
      );
    }
    mockGamepad.buttons[index] = {
      pressed: Boolean(pressed),
      value: pressed ? 1.0 : 0.0,
      touched: Boolean(pressed),
    };
    mockGamepad.timestamp = performance.now();
    return { index, pressed: Boolean(pressed) };
  };

  window.__qaSetButtonAnalog = function (index, value) {
    // For triggers — partial-press support
    if (!mockGamepad) throw new Error("No mock gamepad installed");
    const v = Math.max(0, Math.min(1, Number(value)));
    mockGamepad.buttons[index] = {
      pressed: v > 0.5,
      value: v,
      touched: v > 0.05,
    };
    mockGamepad.timestamp = performance.now();
    return { index, value: v };
  };

  window.__qaSetAxis = function (index, value) {
    if (!mockGamepad) throw new Error("No mock gamepad installed");
    if (index < 0 || index >= mockGamepad.axes.length) {
      throw new Error(
        `Axis index ${index} out of range (0..${mockGamepad.axes.length - 1})`
      );
    }
    const v = Math.max(-1, Math.min(1, Number(value)));
    mockGamepad.axes[index] = v;
    mockGamepad.timestamp = performance.now();
    return { index, value: v };
  };

  window.__qaDisconnect = function () {
    if (!mockGamepad) return { wasActive: false };
    const oldGamepad = mockGamepad;
    mockGamepad = null;
    setTimeout(() => {
      const ev = new Event("gamepaddisconnected");
      ev.gamepad = oldGamepad;
      window.dispatchEvent(ev);
    }, 0);
    return { wasActive: true, id: oldGamepad.id };
  };

  window.__qaGetMockState = function () {
    return mockGamepad
      ? {
          id: mockGamepad.id,
          mapping: mockGamepad.mapping,
          connected: mockGamepad.connected,
          numButtons: mockGamepad.buttons.length,
          numAxes: mockGamepad.axes.length,
          buttonsPressed: mockGamepad.buttons.map((b) => b.pressed),
          axes: [...mockGamepad.axes],
        }
      : null;
  };

  // Marker the harness can poll to confirm the init script ran
  window.__qaMockInstalled = true;
})();
