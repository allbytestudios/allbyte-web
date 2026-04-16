// Client-side subscription to the dev-only SSE stream from the Vite
// middleware (`/test-data-events`). In prod this is a no-op — components
// fall back to polling.
//
// Usage:
//   const unsub = subscribeToFile("tickets/owner_questions.json", () => refetch());
//   onDestroy(unsub);

type Listener = () => void;

const listeners = new Map<string, Set<Listener>>();
let source: EventSource | null = null;
let connecting = false;
let reconnectDelay = 1000;

function connect() {
  if (typeof window === "undefined") return;
  if (!import.meta.env.DEV) return;
  if (source || connecting) return;
  connecting = true;
  try {
    source = new EventSource("/test-data-events/");
  } catch {
    connecting = false;
    return;
  }
  source.addEventListener("ready", () => {
    connecting = false;
    reconnectDelay = 1000;
  });
  source.addEventListener("change", (ev: MessageEvent) => {
    try {
      const { path } = JSON.parse(ev.data) as { path: string };
      const set = listeners.get(path);
      if (set) for (const cb of set) cb();
    } catch {}
  });
  source.addEventListener("error", () => {
    if (source) {
      source.close();
      source = null;
    }
    connecting = false;
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  });
}

export function subscribeToFile(path: string, cb: Listener): () => void {
  connect();
  let set = listeners.get(path);
  if (!set) {
    set = new Set();
    listeners.set(path, set);
  }
  set.add(cb);
  return () => {
    const s = listeners.get(path);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) listeners.delete(path);
  };
}
