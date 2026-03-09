export interface CursorRawSession {
  id: string;
  title: string;
  messages: CursorRawMessage[];
  createdAt: number;
  lastMessageAt: number;
  gitBranch?: string;
  linesAdded?: number;
  linesRemoved?: number;
  filesChanged?: number;
  mode?: string;
  subtitle?: string;
  workspacePath?: string;
}

export interface CursorRawMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: number;
}

export type SessionStatus =
  | 'none'
  | 'todo'
  | 'in_progress'
  | 'pr_created'
  | 'in_review'
  | 'changes_requested'
  | 'approved'
  | 'merged'
  | 'done'
  | 'abandoned';

export const SESSION_STATUS_LABELS: Record<SessionStatus, string> = {
  none: '',
  todo: 'TODO',
  in_progress: 'In Progress',
  pr_created: 'PR Created',
  in_review: 'In Code Review',
  changes_requested: 'Changes Requested',
  approved: 'Approved',
  merged: 'Merged',
  done: 'Done',
  abandoned: 'Abandoned',
};

export const SESSION_STATUS_COLORS: Record<SessionStatus, string> = {
  none: '',
  todo: '#d7ba7d',
  in_progress: '#4fc1ff',
  pr_created: '#cca700',
  in_review: '#c586c0',
  changes_requested: '#f14c4c',
  approved: '#4ec9b0',
  merged: '#4ec9b0',
  done: '#6a9955',
  abandoned: '#808080',
};

export interface OverlayMetadata {
  sessionId: string;
  customName?: string;
  tags: string[];
  pinned: boolean;
  status?: SessionStatus;
  groupId?: string;
  relatedSessionIds: string[];
  /** @deprecated Use `branches` instead. Kept for migration from older overlay data. */
  gitBranch?: string;
  branches: string[];
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SessionMetrics {
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  codeBlockCount: number;
  filesTouched: string[];
  estimatedDurationMs: number;
  linesAdded?: number;
  linesRemoved?: number;
  filesChangedCount?: number;
  mode?: string;
}

export interface Session {
  id: string;
  displayName: string;
  autoTitle: string;
  messages: CursorRawMessage[];
  createdAt: number;
  lastMessageAt: number;

  customName?: string;
  tags: string[];
  pinned: boolean;
  status: SessionStatus;
  groupId?: string;
  relatedSessionIds: string[];
  branches: string[];
  notes?: string;
  workspacePath?: string;

  metrics: SessionMetrics;
}

export interface SessionGroup {
  id: string;
  name: string;
  sessionIds: string[];
  color?: string;
}

export interface OverlayStore {
  version: number;
  sessions: Record<string, OverlayMetadata>;
  groups: Record<string, SessionGroup>;
  hiddenSessionIds?: string[];
}

export type SessionSortField = 'lastMessageAt' | 'createdAt' | 'displayName' | 'messageCount';
export type SessionSortOrder = 'asc' | 'desc';

export interface SessionFilter {
  searchQuery?: string;
  tags?: string[];
  pinned?: boolean;
  groupId?: string;
  dateFrom?: number;
  dateTo?: number;
  workspacePath?: string;
}

export interface SessionListOptions {
  filter?: SessionFilter;
  sortBy?: SessionSortField;
  sortOrder?: SessionSortOrder;
}
