import * as vscode from 'vscode';
import { CursorDbReader } from './cursorDbReader';
import { OverlayStore } from './overlayStore';
import {
  Session,
  SessionMetrics,
  CursorRawSession,
  CursorRawMessage,
  SessionFilter,
  SessionListOptions,
  SessionGroup,
  JIRA_TICKET_REGEX,
} from '../models/types';

const CODE_BLOCK_REGEX = /```[\s\S]*?```/g;
const FILE_PATH_REGEX = /(?:^|\s)((?:\/|\.\/|~\/|[A-Z]:\\)[\w./-]+\.\w+)/gm;

export class SessionManager {
  private cachedSessions: Session[] = [];
  private lastRefresh = 0;
  private readonly CACHE_TTL_MS = 30_000;

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly dbReader: CursorDbReader,
    private readonly overlay: OverlayStore,
  ) {
    overlay.onDidChange(() => {
      this.invalidateCache();
      this._onDidChange.fire();
    });
  }

  async getSessions(options?: SessionListOptions): Promise<Session[]> {
    await this.ensureFresh();

    let sessions = [...this.cachedSessions];

    if (options?.filter) {
      sessions = this.applyFilter(sessions, options.filter);
    }

    const sortBy = options?.sortBy ?? 'lastMessageAt';
    const sortOrder = options?.sortOrder ?? 'desc';
    sessions = this.applySort(sessions, sortBy, sortOrder);

    // Pinned sessions always float to the top regardless of sort
    const pinned = sessions.filter(s => s.pinned);
    const unpinned = sessions.filter(s => !s.pinned);
    return [...pinned, ...unpinned];
  }

  async getSession(sessionId: string): Promise<Session | undefined> {
    await this.ensureFresh();
    return this.cachedSessions.find(s => s.id === sessionId);
  }

  async getActiveSessionId(currentFolderPaths: string[]): Promise<string | undefined> {
    return this.dbReader.getActiveSessionId(currentFolderPaths);
  }

  /**
   * Returns todos sorted with non-archived first, then by recency. Each
   * attached session id is enriched with a lightweight title so the webview
   * can render attached-session lists without a second lookup.
   */
  async getTodosWithSessionTitles(): Promise<Array<import('../models/types').Todo & {
    attachedSessions: { id: string; title: string }[];
  }>> {
    await this.ensureFresh();
    const todos = this.overlay.getAllTodos();
    const titleById = new Map<string, string>();
    for (const s of this.cachedSessions) {
      titleById.set(s.id, s.displayName);
    }
    const enriched = todos.map(t => ({
      ...t,
      attachedSessions: t.sessionIds.map(id => ({
        id,
        title: titleById.get(id) ?? '(unknown session)',
      })),
    }));
    enriched.sort((a, b) => {
      const aArch = a.status === 'archived' ? 1 : 0;
      const bArch = b.status === 'archived' ? 1 : 0;
      if (aArch !== bArch) { return aArch - bArch; }
      return b.updatedAt - a.updatedAt;
    });
    return enriched;
  }

  /**
   * Full-text search over sessions.
   *
   * - `scope === 'title'` limits the haystack to identity/metadata fields
   *   (name, auto title, JIRA key, tags, branches, notes) — fast, low noise.
   * - `scope === 'all'` (default) additionally scans message content, which
   *   is much more thorough but proportionally more expensive.
   */
  async searchSessions(query: string, scope: 'title' | 'all' = 'all'): Promise<Session[]> {
    await this.ensureFresh();
    if (!query.trim()) { return this.cachedSessions; }

    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const includeMessages = scope !== 'title';

    return this.cachedSessions.filter(session => {
      const haystackParts: string[] = [
        session.displayName,
        session.autoTitle,
        session.jiraTicket ?? '',
        session.notes ?? '',
        ...session.tags,
        ...session.branches,
      ];
      if (includeMessages) {
        for (const m of session.messages) { haystackParts.push(m.content); }
      }
      const searchable = haystackParts.join(' ').toLowerCase();

      return terms.every(term => searchable.includes(term));
    });
  }

  async getRelatedSessions(sessionId: string): Promise<Session[]> {
    await this.ensureFresh();
    const session = this.cachedSessions.find(s => s.id === sessionId);
    if (!session || session.relatedSessionIds.length === 0) { return []; }

    const relatedIds = new Set(session.relatedSessionIds);
    return this.cachedSessions.filter(s => relatedIds.has(s.id));
  }

  async getGroups(): Promise<SessionGroup[]> {
    return this.overlay.getAllGroups();
  }

  async getSessionsByGroup(groupId: string): Promise<Session[]> {
    await this.ensureFresh();
    return this.cachedSessions.filter(s => s.groupId === groupId);
  }

  getAllTags(): string[] {
    return this.overlay.getAllTags();
  }

  async refresh(): Promise<void> {
    const rawSessions = await this.dbReader.readAllSessions();
    const allMeta = this.overlay.getAllMetadata();
    const hidden = this.overlay.getHiddenIds();

    this.cachedSessions = rawSessions
      .filter(raw => !hidden.has(raw.id))
      .map(raw => this.mergeSession(raw, allMeta[raw.id]));
    this.lastRefresh = Date.now();
    this._onDidChange.fire();
  }

  async exportSession(sessionId: string, format: 'markdown' | 'json'): Promise<string> {
    const session = await this.getSession(sessionId);
    if (!session) { throw new Error(`Session ${sessionId} not found`); }

    if (format === 'json') {
      return JSON.stringify(session, null, 2);
    }

    return this.toMarkdown(session);
  }

  invalidateCache(): void {
    this.lastRefresh = 0;
  }

  dispose(): void {
    this._onDidChange.dispose();
  }

  private async ensureFresh(): Promise<void> {
    if (Date.now() - this.lastRefresh > this.CACHE_TTL_MS) {
      await this.refresh();
    }
  }

  private mergeSession(raw: CursorRawSession, overlay?: { customName?: string; tags: string[]; pinned: boolean; status?: import('../models/types').SessionStatus; groupId?: string; relatedSessionIds: string[]; branches: string[]; notes?: string; jiraTicket?: string }): Session {
    const metrics = this.computeMetrics(raw.messages);

    if (raw.linesAdded !== undefined) { metrics.linesAdded = raw.linesAdded; }
    if (raw.linesRemoved !== undefined) { metrics.linesRemoved = raw.linesRemoved; }
    if (raw.filesChanged !== undefined) { metrics.filesChangedCount = raw.filesChanged; }
    if (raw.mode) { metrics.mode = raw.mode; }

    const branches = [...(overlay?.branches ?? [])];
    if (raw.gitBranch && !branches.includes(raw.gitBranch)) {
      branches.unshift(raw.gitBranch);
    }

    const tags = overlay?.tags ?? [];
    const explicitTicket = overlay?.jiraTicket?.trim();
    const jiraTicket = explicitTicket && explicitTicket.length > 0
      ? explicitTicket
      : this.detectJiraTicket(tags, overlay?.customName, raw.title);

    return {
      id: raw.id,
      autoTitle: raw.title,
      displayName: overlay?.customName ?? raw.title,
      messages: raw.messages,
      createdAt: raw.createdAt,
      lastMessageAt: raw.lastMessageAt,

      customName: overlay?.customName,
      tags,
      pinned: overlay?.pinned ?? false,
      status: overlay?.status ?? 'none',
      groupId: overlay?.groupId,
      relatedSessionIds: overlay?.relatedSessionIds ?? [],
      branches,
      notes: overlay?.notes,
      jiraTicket,
      workspacePath: raw.workspacePath,

      metrics,
    };
  }

  private detectJiraTicket(tags: string[], customName?: string, autoTitle?: string): string | undefined {
    for (const tag of tags) {
      const m = tag.toUpperCase().match(JIRA_TICKET_REGEX);
      if (m) { return m[1]; }
    }
    for (const candidate of [customName, autoTitle]) {
      if (!candidate) { continue; }
      const m = candidate.toUpperCase().match(JIRA_TICKET_REGEX);
      if (m) { return m[1]; }
    }
    return undefined;
  }

  private computeMetrics(messages: CursorRawMessage[]): SessionMetrics {
    let codeBlockCount = 0;
    const filePaths = new Set<string>();

    for (const msg of messages) {
      const codeBlocks = msg.content.match(CODE_BLOCK_REGEX);
      if (codeBlocks) { codeBlockCount += codeBlocks.length; }

      const paths = msg.content.match(FILE_PATH_REGEX);
      if (paths) {
        for (const p of paths) { filePaths.add(p.trim()); }
      }
    }

    const timestamps = messages.filter(m => m.timestamp).map(m => m.timestamp!);
    const duration = timestamps.length >= 2
      ? Math.max(...timestamps) - Math.min(...timestamps)
      : 0;

    return {
      messageCount: messages.length,
      userMessageCount: messages.filter(m => m.role === 'user').length,
      assistantMessageCount: messages.filter(m => m.role === 'assistant').length,
      codeBlockCount,
      filesTouched: [...filePaths].slice(0, 50),
      estimatedDurationMs: duration,
    };
  }

  private applyFilter(sessions: Session[], filter: SessionFilter): Session[] {
    return sessions.filter(s => {
      if (filter.workspacePath && s.workspacePath !== filter.workspacePath) { return false; }
      if (filter.pinned !== undefined && s.pinned !== filter.pinned) { return false; }
      if (filter.groupId && s.groupId !== filter.groupId) { return false; }
      if (filter.dateFrom && s.lastMessageAt < filter.dateFrom) { return false; }
      if (filter.dateTo && s.lastMessageAt > filter.dateTo) { return false; }

      if (filter.tags && filter.tags.length > 0) {
        if (!filter.tags.some(t => s.tags.includes(t))) { return false; }
      }

      if (filter.searchQuery) {
        const q = filter.searchQuery.toLowerCase();
        const haystack = [
          s.displayName,
          s.autoTitle,
          s.notes ?? '',
          s.jiraTicket ?? '',
          ...s.tags,
          ...s.branches,
          ...s.messages.map(m => m.content),
        ].join(' ').toLowerCase();
        if (!haystack.includes(q)) { return false; }
      }

      return true;
    });
  }

  private applySort(sessions: Session[], field: string, order: string): Session[] {
    const cmp = (a: Session, b: Session): number => {
      switch (field) {
        case 'createdAt': return a.createdAt - b.createdAt;
        case 'displayName': return a.displayName.localeCompare(b.displayName);
        case 'messageCount': return a.metrics.messageCount - b.metrics.messageCount;
        default: return a.lastMessageAt - b.lastMessageAt;
      }
    };

    sessions.sort((a, b) => order === 'asc' ? cmp(a, b) : cmp(b, a));
    return sessions;
  }

  private toMarkdown(session: Session): string {
    const lines: string[] = [];
    lines.push(`# ${session.displayName}`);
    lines.push('');

    if (session.tags.length > 0) {
      lines.push(`**Tags:** ${session.tags.map(t => `\`${t}\``).join(' ')}`);
    }
    if (session.branches.length > 0) {
      lines.push(`**Branches:** ${session.branches.join(', ')}`);
    }
    lines.push(`**Messages:** ${session.metrics.messageCount} (${session.metrics.userMessageCount} user, ${session.metrics.assistantMessageCount} assistant)`);
    lines.push(`**Code Blocks:** ${session.metrics.codeBlockCount}`);
    lines.push(`**Created:** ${new Date(session.createdAt).toISOString()}`);
    lines.push(`**Last Active:** ${new Date(session.lastMessageAt).toISOString()}`);
    lines.push('');
    lines.push('---');
    lines.push('');

    for (const msg of session.messages) {
      const roleLabel = msg.role === 'user' ? '**User**' : msg.role === 'assistant' ? '**Assistant**' : '**System**';
      lines.push(`### ${roleLabel}`);
      lines.push('');
      lines.push(msg.content);
      lines.push('');
    }

    return lines.join('\n');
  }
}
