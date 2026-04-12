export type TicketPriority = "P0" | "P1" | "P2" | "P3" | "done";
export type TicketStatus =
  | "open"
  | "investigating"
  | "in_progress"
  | "testing"
  | "done"
  | "deferred"
  | "expected behavior"
  | "partially fixed"
  | "known, HTML5 limitation";
export type TicketType = "bug" | "feature" | "investigation" | "port" | "documentation";
export type ExpertId = "qa" | "game" | "test" | "web-export";

export interface Subtask {
  task: string;
  status: "pending" | "in_progress" | "done" | "blocked";
  assignedTo?: string;
  result?: string;
}

export interface Ticket {
  id: string;
  title: string;
  priority: TicketPriority;
  status: TicketStatus;
  type: TicketType;
  ownerExpert: ExpertId | string;
  created: string;
  updated: string;
  reportedVersion?: string;
  currentVersion?: string;
  blocksDemo?: boolean;
  tags?: string[];
  description: string;
  reproductionSteps?: string[];
  subtasks?: Subtask[];
  relatedFiles?: string[];
  lastUpdate: string;
  eventChain?: {
    eventId: number;
    hangAfterOrder: number;
    nextCommands: string[];
  };
}

export interface TicketsFile {
  version: number;
  lastUpdated: string;
  tickets: Ticket[];
}

export interface ExpertStatus {
  status: "active" | "investigating" | "idle" | "spawning_worker" | string;
  doing: string | null;
  ticketCount: number;
  ownedDocs?: string[];
}

export interface DashboardWorker {
  id: string;
  expert: string;
  task: string;
  started: string;
  status: "running" | "done" | string;
}

export interface DashboardFile {
  lastUpdated: string;
  session: number;
  deployedVersion: string;
  experts: Record<string, ExpertStatus>;
  workers: DashboardWorker[];
  ticketSummary: Record<string, Record<string, number>>;
  recentActivity: { time: string; action: string }[];
  testSuite?: {
    totalTests: number;
    totalFiles: number;
    lastRun: string | null;
    passRate: number | null;
  };
}

export interface AgentExpert {
  id: string;
  role: string;
  status: string;
  promptFile: string;
  ownedDocs: string[];
  devlog: string;
  description: string;
  activeWorkers: string[];
}

export interface AgentWorkerHistory {
  id: string;
  expert: string;
  task: string;
  ticket: string | null;
  started: string;
  completed: string;
  result: string;
  duration_min: number;
}

export interface AgentsFile {
  version: number;
  lastUpdated: string;
  experts: AgentExpert[];
  workerSlots: { max: number; active: number; reason: string };
  workers: DashboardWorker[];
  workerHistory: AgentWorkerHistory[];
}

export const PRIORITY_ORDER: TicketPriority[] = ["P0", "P1", "P2", "P3", "done"];

export const PRIORITY_META: Record<TicketPriority, { label: string; color: string }> = {
  P0: { label: "Demo Blocker", color: "#f87171" },
  P1: { label: "Important", color: "#fbbf24" },
  P2: { label: "Polish", color: "#60a5fa" },
  P3: { label: "Deferred", color: "#9ca3af" },
  done: { label: "Done", color: "#a7f3d0" },
};

export const EXPERT_META: Record<string, { label: string; color: string }> = {
  qa: { label: "Planning / QA", color: "#c084fc" },
  game: { label: "Game Systems", color: "#fbbf24" },
  test: { label: "Test Implementation", color: "#a7f3d0" },
  "web-export": { label: "Web Export", color: "#60a5fa" },
};

export function statusColor(s: TicketStatus): string {
  switch (s) {
    case "open": return "#9ca3af";
    case "investigating": return "#fbbf24";
    case "in_progress": return "#60a5fa";
    case "testing": return "#c084fc";
    case "done": return "#a7f3d0";
    case "deferred": return "#6b7280";
    default: return "#9ca3af";
  }
}

export function subtaskProgress(t: Ticket): { done: number; total: number } {
  if (!t.subtasks?.length) return { done: 0, total: 0 };
  return {
    done: t.subtasks.filter((s) => s.status === "done").length,
    total: t.subtasks.length,
  };
}
