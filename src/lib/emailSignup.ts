/**
 * Anonymous email capture — "tell me when the next Episode is playable".
 *
 * Two surfaces, ONE list: the homepage (someone who hasn't played yet) and an
 * overlay at the end of the Episode 1 credits (someone who just finished). Both
 * POST here with a `source` tag so we can see which one actually converts;
 * segmenting into two lists would only make the eventual send harder.
 *
 * This is NOT the Patreon account system. These people have no account and no
 * tier — they are rows in their own table, deliberately kept out of
 * `allbyte-studio-users` so they cannot skew tier counts, `/counts`, or
 * `/admin/users`, all of which scan that table.
 *
 * Nothing sends automatically. The list collects; the release mail is a manual
 * broadcast when Episode 2 is actually ready.
 */

export const SIGNUP_ENABLED = true;

/**
 * Its own stack (`allbyte-studio-email-notify`), not api.allbyte.studio — that
 * custom domain is mapped to the auth/saves API only. Same pattern as the
 * manual-overlay, bug-report and play-analytics stacks, which all address their
 * own execute-api endpoint directly.
 */
const API = "https://gabgrzxo42.execute-api.us-east-1.amazonaws.com";

export type SignupSource = "home" | "ep1_credits";

/** Remembers a success so a returning visitor isn't asked twice. */
const DONE_KEY = "allbyte_notify_signup";

export function alreadySignedUp(): boolean {
  try {
    return localStorage.getItem(DONE_KEY) === "1";
  } catch {
    return false; // private mode / storage disabled — just ask again
  }
}

function markSignedUp() {
  try {
    localStorage.setItem(DONE_KEY, "1");
  } catch {
    /* non-fatal */
  }
}

/**
 * Deliberately loose. The server is the authority; this only catches the
 * obvious typo before a round trip. Over-strict client regexes reject real
 * addresses (plus-tags, long TLDs, unicode domains) and that costs subscribers.
 */
export function looksLikeEmail(v: string): boolean {
  const s = v.trim();
  return s.length >= 5 && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

export type SignupResult = { ok: true } | { ok: false; error: string };

/**
 * `honeypot` must be the value of a field hidden from humans. Bots fill every
 * input they find; a non-empty value means "silently accept and discard" rather
 * than "reject", so the bot gets no signal to retry differently.
 */
export async function submitSignup(
  email: string,
  source: SignupSource,
  honeypot: string,
): Promise<SignupResult> {
  if (!looksLikeEmail(email)) {
    return { ok: false, error: "That doesn't look like an email address." };
  }
  try {
    const r = await fetch(`${API}/notify/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim(), source, hp: honeypot }),
    });
    if (!r.ok) {
      // 429 is the rate limiter; everything else is ours to own, not the
      // visitor's to decode.
      return {
        ok: false,
        error:
          r.status === 429
            ? "Too many tries just now. Give it a minute."
            : "Something broke on my end. Try again in a moment.",
      };
    }
    markSignedUp();
    return { ok: true };
  } catch {
    return { ok: false, error: "Couldn't reach the server. Check your connection." };
  }
}
