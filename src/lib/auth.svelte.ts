const API = "https://wj3xkrm1r1.execute-api.us-east-1.amazonaws.com";

export interface User {
  userId: string;
  email: string;
  username: string;
  tier: string | null;
  stripeCustomerId: string | null;
}

class AuthStore {
  currentUser = $state<User | null>(null);
  authToken = $state<string | null>(null);
  authReady = $state(false);
}

export const auth = new AuthStore();

export async function initAuth() {
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

export function logout() {
  localStorage.removeItem("allbyte_token");
  auth.authToken = null;
  auth.currentUser = null;
}
