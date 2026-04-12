import type { Tier } from "./tier";

const API = "https://wj3xkrm1r1.execute-api.us-east-1.amazonaws.com";

export interface User {
  userId: string;
  email: string;
  username: string;
  /** One of the 5 enum values from src/lib/tier.ts. May still be string|null
   *  on legacy responses from before the backend refactor. */
  tier: Tier | string | null;
  stripeCustomerId: string | null;
  notificationPreferences: Record<string, boolean> | null;
}

class AuthStore {
  currentUser = $state<User | null>(null);
  authToken = $state<string | null>(null);
  authReady = $state(false);
}

export const auth = new AuthStore();

export function oauthLogin(provider: "google" | "discord") {
  window.location.href = `${API}/auth/oauth/${provider}`;
}

export async function initAuth() {
  // Check for OAuth callback token in URL hash
  const hash = window.location.hash;
  if (hash) {
    const params = new URLSearchParams(hash.substring(1));
    const oauthToken = params.get("token");
    // Clear hash from URL immediately
    history.replaceState(null, "", window.location.pathname + window.location.search);
    if (oauthToken) {
      localStorage.setItem("allbyte_token", oauthToken);
    }
  }

  const token = localStorage.getItem("allbyte_token");
  if (!token) {
    auth.authReady = true;
    return;
  }
  try {
    const resp = await fetch(`${API}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (resp.ok) {
      const data = await resp.json();
      auth.currentUser = data.user;
      auth.authToken = token;
    } else {
      localStorage.removeItem("allbyte_token");
    }
  } catch {
    // API unreachable
  }
  auth.authReady = true;

  // Handle pending action from OAuth redirect
  if (auth.currentUser) {
    const pending = sessionStorage.getItem("allbyte_pending_action");
    if (pending) {
      sessionStorage.removeItem("allbyte_pending_action");
      if (pending === "subscribe") {
        window.location.href = "/subscribe/";
      }
    }
  }
}

export async function login(email: string, password: string): Promise<string | null> {
  const resp = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await resp.json();
  if (!resp.ok) return data.error || "Login failed";
  localStorage.setItem("allbyte_token", data.token);
  auth.authToken = data.token;
  auth.currentUser = data.user;
  return null;
}

export async function signup(email: string, username: string, password: string): Promise<string | null> {
  const resp = await fetch(`${API}/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, username, password }),
  });
  const data = await resp.json();
  if (!resp.ok) return data.error || "Signup failed";
  localStorage.setItem("allbyte_token", data.token);
  auth.authToken = data.token;
  auth.currentUser = data.user;
  return null;
}

export async function saveNotificationPrefs(
  preferences: Record<string, boolean> | null
): Promise<string | null> {
  const token = localStorage.getItem("allbyte_token");
  if (!token) return "Not authenticated";
  const resp = await fetch(`${API}/auth/notification-prefs`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ preferences }),
  });
  if (!resp.ok) {
    const data = await resp.json();
    return data.error || "Failed to save preferences";
  }
  if (auth.currentUser) {
    auth.currentUser = { ...auth.currentUser, notificationPreferences: preferences };
  }
  return null;
}

export function logout() {
  localStorage.removeItem("allbyte_token");
  auth.authToken = null;
  auth.currentUser = null;
}

export function devLogin(tier: string) {
  auth.currentUser = {
    userId: "dev-local",
    email: "dev@localhost",
    username: "dev",
    tier,
    stripeCustomerId: null,
    notificationPreferences: null,
  };
  auth.authToken = "dev-local-token";
  auth.authReady = true;
}
