export type TicketPriority = "P0" | "P1" | "P2" | "P3" | "done";
export type TicketPhase =
  | "planning"
  | "tech_review"
  | "ready"
  | "in_progress"
  | "testing"
  | "done"
  | "deferred";
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

export interface SuccessCriterion {
  criterion: string;
  testSpec: string | null;
  testShape: string | null;
  veraApproved: boolean;
}

export type CommentType = "review" | "question" | "answer" | "decision" | "status";

export interface Comment {
  author: string;
  timestamp: string;
  type: CommentType;
  content: string;
}

export const COMMENT_TYPE_META: Record<CommentType, { label: string; color: string }> = {
  review: { label: "Review", color: "#60a5fa" },
  question: { label: "Question", color: "#fbbf24" },
  answer: { label: "Answer", color: "#a7f3d0" },
  decision: { label: "Decision", color: "#f97316" },
  status: { label: "Status", color: "#9ca3af" },
};

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
  // v2 fields (optional for backward compat)
  awaitingOwner?: boolean;
  phase?: TicketPhase;
  leads?: string[];
  leadReview?: Record<string, string | { call: string; note?: string }>;
  successCriteria?: SuccessCriterion[];
  milestone?: string;
  epic?: string;
  comments?: Comment[];
  phaseHistory?: { phase: TicketPhase; entered: string }[];
  resources?: { estimatedSlots?: number; needsBrowser?: boolean; needsExport?: boolean };
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

export interface Epic {
  id: string;
  title: string;
  milestone: string;
  status: "planned" | "in_progress" | "investigating" | "done" | string;
  description: string;
  ticketIds: string[];
  estimatedHours?: number;
  acceptanceCriteria?: string;
  visualMockup?: string;
  ownerReviewNeeded?: boolean;
  ownerReviewReason?: string;
  created: string;
  updated: string;
}

export interface EpicsFile {
  version: number;
  lastUpdated: string;
  epics: Epic[];
}

export interface FixtureEntry {
  id: string;
  name: string;
  description: string;
  savePath: string;
  gameVersion: string;
  scene: string;
  completedEvents?: number[];
  inventory?: string[];
  partyLevel?: number;
  tags?: string[];
  createdBy?: string;
  createdAt: string;
}

export interface FixtureManifest {
  version: number;
  lastUpdated: string;
  fixtures: FixtureEntry[];
}

export interface ChatMessage {
  timestamp: string;
  from: string;
  to: string;
  channel: string;
  message: string;
  refs?: string[];
}

export interface AgentSubagents {
  active: number;
  completed: number;
  total_spawned: number;
  workers: { id: string; task: string; started: string; status: string }[];
}

export interface AgentActivity {
  schema_version: number;
  lastUpdated: string;
  activeAgents: {
    agent: string;
    task: string;
    tickets: string[];
    started: string;
    status: string;
    subagents?: AgentSubagents;
  }[];
  recentActivity: {
    agent: string;
    task: string;
    completed: string;
    result: string;
  }[];
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
  qa: { label: "Arc", color: "#c084fc" },
  game: { label: "Nix", color: "#fbbf24" },
  test: { label: "Vera", color: "#a7f3d0" },
  "web-export": { label: "Port", color: "#60a5fa" },
  // v2 agent name aliases
  arc: { label: "Arc", color: "#c084fc" },
  nix: { label: "Nix", color: "#fbbf24" },
  vera: { label: "Vera", color: "#a7f3d0" },
  port: { label: "Port", color: "#60a5fa" },
};

export const TEST_SHAPE_META: Record<string, { label: string; color: string }> = {
  A: { label: "Scene-based", color: "#a7f3d0" },
  B: { label: "Fixture", color: "#60a5fa" },
  C: { label: "Traversal", color: "#fbbf24" },
  D: { label: "Playthrough", color: "#f87171" },
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

export function phaseColor(p: string): string {
  switch (p) {
    case "planning": return "#818cf8";
    case "tech_review": return "#f472b6";
    case "ready": return "#34d399";
    case "in_progress": return "#60a5fa";
    case "testing": return "#c084fc";
    case "done": return "#a7f3d0";
    case "deferred": return "#6b7280";
    default: return "#9ca3af";
  }
}

export function effectivePhase(t: Ticket): string {
  return t.phase ?? t.status;
}

export function subtaskProgress(t: Ticket): { done: number; total: number } {
  if (!t.subtasks?.length) return { done: 0, total: 0 };
  return {
    done: t.subtasks.filter((s) => s.status === "done").length,
    total: t.subtasks.length,
  };
}

// =====================================================================
// Owner Questions Queue
//
// Synthesized "things waiting on AllByte" file Arc maintains and AppC
// reads. Aggregates 5 source types (decisions, tickets needing review,
// epic outstanding questions, leads blocked on owner, verification
// requests) into a single queue rendered at /test/questions/.
//
// Design contract: schema CON_CLAUDE_OWNER_QUESTIONS_CONFIRMED.md.
// Source of truth is always the originating file (tickets.json,
// agent_chat.ndjson, etc.) — owner_questions.json is a derived view.
// =====================================================================

export type OwnerQuestionSource =
  | "decision"
  | "ticket"
  | "epic"
  | "blocker"
  | "verification";

export type OwnerQuestionAnswerType = "choice" | "verification" | "freeText";

export type OwnerQuestionStatus = "pending" | "resolved" | "obsolete";

export interface OwnerQuestionArtifact {
  type: string; // "screenshot" | "test" | "scene" | "ticket" | etc.
  path: string;
}

export interface OwnerQuestion {
  // Required core
  id: string;
  source: OwnerQuestionSource;
  answerType: OwnerQuestionAnswerType;
  question: string;
  status: OwnerQuestionStatus;
  createdAt: string;
  createdBy: string;

  // Optional render enrichment
  context?: string;
  priority?: "P0" | "P1" | "P2" | "P3";
  ticket?: string;
  epic?: string;
  options?: string[];      // required when answerType === "choice"
  default?: string;        // optional, only meaningful for choice
  sourceFile?: string;
  sourceId?: string;
  relatedArtifacts?: OwnerQuestionArtifact[];

  // Set by Arc when status flips
  resolvedAt?: string;
  resolvedAnswer?: unknown;
}

export interface OwnerQuestionsFile {
  schema_version: number;
  lastUpdated: string;
  questions: OwnerQuestion[];
}

// Write-back shape: what the webapp POSTs to /api/answers and what Arc
// tails out of owner_answers.ndjson. One entry per answer.
export interface OwnerAnswer {
  questionId: string;
  answeredAt: string;
  answeredBy: string;       // hardcoded "AllByte" for now (Pre-Alpha)
  answerType: OwnerQuestionAnswerType;
  // Exactly one of these is populated per answer, matching answerType:
  choice?: string | null;
  verified?: boolean | null;
  issueNote?: string | null;     // populated when verified === false
  freeText?: string | null;
}

export const SOURCE_META: Record<OwnerQuestionSource, { label: string; color: string }> = {
  decision: { label: "Decision", color: "#fbbf24" },
  ticket: { label: "Ticket", color: "#60a5fa" },
  epic: { label: "Epic", color: "#c084fc" },
  blocker: { label: "Blocker", color: "#f87171" },
  verification: { label: "Verify", color: "#a7f3d0" },
};

const PRIORITY_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** Sort: priority first (P0 → P3, missing last), then createdAt ascending (oldest first). */
export function sortOwnerQuestions(qs: OwnerQuestion[]): OwnerQuestion[] {
  return [...qs].sort((a, b) => {
    const pa = a.priority ? PRIORITY_RANK[a.priority] : 99;
    const pb = b.priority ? PRIORITY_RANK[b.priority] : 99;
    if (pa !== pb) return pa - pb;
    return (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
  });
}
