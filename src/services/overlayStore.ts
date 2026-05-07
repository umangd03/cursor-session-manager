import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
  OverlayMetadata,
  OverlayStore as OverlayStoreData,
  SessionGroup,
  SessionStatus,
  Todo,
  TodoStatus,
} from '../models/types';
import { log } from './logger';

const STORE_FILENAME = 'sessions-overlay.json';
const CURRENT_VERSION = 1;

const VALID_SESSION_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  'none', 'todo', 'in_progress', 'pr_created', 'in_review',
  'changes_requested', 'approved', 'merged', 'done', 'abandoned',
]);
const VALID_TODO_STATUSES: ReadonlySet<TodoStatus> = new Set<TodoStatus>([
  'open', 'in_progress', 'done', 'archived',
]);

/**
 * Reflects how the on-disk overlay file looked at startup.
 *
 * - `ok`: file existed and parsed cleanly (or did not exist — we'll create
 *   it on first save). Writes are allowed.
 * - `fresh-after-quarantine`: the on-disk file was unreadable / wrong
 *   version, so we renamed it to `.corrupt-<ts>.json` to preserve it and
 *   started with an empty in-memory state. Writes are allowed; the
 *   corrupted copy is left alone for manual recovery from the user's
 *   backups directory.
 * - `quarantine-failed`: load failed AND we couldn't rename the corrupt
 *   file out of the way. Writes are blocked because the next save would
 *   silently overwrite the user's tags/pins/TODOs with an empty store.
 */
type OverlayLoadState = 'ok' | 'fresh-after-quarantine' | 'quarantine-failed';

export class OverlayStore {
  private data: OverlayStoreData;
  private storePath: string;
  private dirty = false;
  private loadState: OverlayLoadState = 'ok';

  /**
   * In-flight save promise. We never let two saves race because
   * `fs.renameSync` between them would clobber each other and the order
   * isn't guaranteed under the event loop.
   */
  private savingPromise: Promise<void> | null = null;
  private pendingSave = false;

  private readonly _onDidChange = new vscode.EventEmitter<string | undefined>();
  readonly onDidChange = this._onDidChange.event;

  constructor(storageUri: vscode.Uri) {
    this.storePath = vscode.Uri.joinPath(storageUri, STORE_FILENAME).fsPath;
    this.data = this.load();
    if (this.loadState !== 'ok') {
      this.notifyLoadFailure();
    }
  }

  /**
   * Read the overlay file. On any parse / version failure we move the
   * suspect file aside (timestamped `.corrupt-...` suffix) so a later
   * `save()` cannot silently overwrite the user's metadata with an empty
   * store. If we can't rename it, we set `loadState = 'quarantine-failed'`
   * and `save()` will refuse to write.
   */
  private load(): OverlayStoreData {
    if (!fs.existsSync(this.storePath)) {
      this.loadState = 'ok';
      return this.emptyStore();
    }
    let raw: string;
    try {
      raw = fs.readFileSync(this.storePath, 'utf-8');
    } catch (err) {
      log.error('[OverlayStore] Failed to read store file', err);
      this.loadState = 'quarantine-failed';
      return this.emptyStore();
    }
    try {
      const parsed = JSON.parse(raw) as OverlayStoreData;
      if (parsed && typeof parsed === 'object' && parsed.version === CURRENT_VERSION) {
        this.migrateGitBranchToBranches(parsed);
        this.migrateTodoWebexLink(parsed);
        this.sanitizeStatuses(parsed);
        this.loadState = 'ok';
        return parsed;
      }
      log.error(
        `[OverlayStore] Unsupported store version: expected ${CURRENT_VERSION}, ` +
        `got ${(parsed as { version?: unknown })?.version}`,
      );
    } catch (err) {
      log.error('[OverlayStore] Failed to parse store JSON', err);
    }
    if (this.quarantineCorruptFile()) {
      this.loadState = 'fresh-after-quarantine';
    } else {
      this.loadState = 'quarantine-failed';
    }
    return this.emptyStore();
  }

  private emptyStore(): OverlayStoreData {
    return { version: CURRENT_VERSION, sessions: {}, groups: {} };
  }

  /**
   * Move a corrupt store file to `<dir>/sessions-overlay.corrupt-<iso>.json`
   * so we never overwrite it with a fresh-empty save. Returns whether the
   * rename succeeded — if not, the caller blocks future writes.
   */
  private quarantineCorruptFile(): boolean {
    try {
      const dir = path.dirname(this.storePath);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const dest = path.join(dir, `sessions-overlay.corrupt-${stamp}.json`);
      fs.renameSync(this.storePath, dest);
      log.info(`[OverlayStore] Quarantined unreadable store as ${path.basename(dest)}`);
      return true;
    } catch (err) {
      log.error('[OverlayStore] Failed to quarantine corrupt store; refusing writes', err);
      return false;
    }
  }

  /**
   * Surface the load failure to the user with an actionable hint. Best
   * effort — VS Code may not yet have a UI host; in that case the message
   * is logged and a later command can also surface it.
   */
  private notifyLoadFailure(): void {
    if (this.loadState === 'fresh-after-quarantine') {
      void vscode.window
        .showWarningMessage(
          'Cursor Session Manager: the saved overlay file was unreadable and ' +
          'has been moved aside. Your tags / pins / TODOs may be lost. ' +
          'Restore from a backup if you have one.',
          'Restore from Backup',
        )
        .then((choice) => {
          if (choice === 'Restore from Backup') {
            void vscode.commands.executeCommand('cursorSessions.restoreFromBackup');
          }
        });
    } else if (this.loadState === 'quarantine-failed') {
      void vscode.window
        .showErrorMessage(
          'Cursor Session Manager: failed to read the overlay file and could ' +
          'not move it aside. Writes are disabled to avoid data loss. Inspect ' +
          'the extension logs and restart Cursor.',
        );
    }
  }

  /**
   * Drop unknown enum values so they can never be reflected back into the
   * webview as raw class-name fragments (XSS via class-attribute) or break
   * downstream filter logic that switch()es on them.
   */
  private sanitizeStatuses(data: OverlayStoreData): void {
    for (const meta of Object.values(data.sessions)) {
      if (meta.status !== undefined && !VALID_SESSION_STATUSES.has(meta.status)) {
        log.error(`[OverlayStore] Dropping unknown session status: ${String(meta.status)}`);
        meta.status = undefined;
      }
    }
    if (data.todos) {
      for (const todo of Object.values(data.todos)) {
        if (!VALID_TODO_STATUSES.has(todo.status)) {
          log.error(`[OverlayStore] Coercing unknown todo status to 'open': ${String(todo.status)}`);
          todo.status = 'open';
        }
      }
    }
  }

  isWritable(): boolean {
    return this.loadState !== 'quarantine-failed';
  }

  private migrateTodoWebexLink(data: OverlayStoreData): void {
    if (!data.todos) { return; }
    for (const todo of Object.values(data.todos) as Array<
      Todo & { webexLink?: string; link?: string }
    >) {
      if (!Array.isArray(todo.links)) {
        todo.links = [];
        this.dirty = true;
      }
      const carry = (val: unknown) => {
        if (typeof val === 'string' && val.trim().length > 0 && !todo.links.includes(val)) {
          todo.links.push(val);
          this.dirty = true;
        }
      };
      carry(todo.webexLink);
      carry(todo.link);
      if ('webexLink' in todo) { delete todo.webexLink; this.dirty = true; }
      if ('link' in todo) { delete todo.link; this.dirty = true; }
    }
  }

  private migrateGitBranchToBranches(data: OverlayStoreData): void {
    for (const meta of Object.values(data.sessions)) {
      if (!meta.branches) {
        meta.branches = [];
      }
      if (meta.gitBranch && !meta.branches.includes(meta.gitBranch)) {
        meta.branches.push(meta.gitBranch);
      }
      delete meta.gitBranch;
    }
  }

  /**
   * Persist `data` to disk atomically.
   *
   * Sequence: stringify → write to a sibling `.tmp.<pid>.<ts>` file →
   * `fsync(fd)` to flush kernel buffers → `close` → `fs.renameSync` to
   * the real path. The rename is atomic on POSIX/Windows so a crash
   * never leaves a half-written `sessions-overlay.json`.
   *
   * Concurrency: a single in-flight save is kept; if another mutation
   * lands while we're writing, we set `pendingSave` and run one more
   * pass after the current one completes. This prevents two saves from
   * racing to rename the same target file (which can happen with the
   * fire-and-forget `void this.save()` pattern in some call sites).
   *
   * Errors are propagated. Mutators that called us are responsible for
   * surfacing the failure; we keep `dirty=true` so the next mutation
   * automatically retries.
   */
  async save(): Promise<void> {
    if (!this.dirty) { return; }
    if (this.loadState === 'quarantine-failed') {
      throw new Error('OverlayStore is read-only after a failed quarantine; refusing to save.');
    }

    if (this.savingPromise) {
      this.pendingSave = true;
      return this.savingPromise;
    }

    this.savingPromise = this.performSave().finally(() => {
      this.savingPromise = null;
      if (this.pendingSave) {
        this.pendingSave = false;
        if (this.dirty) {
          void this.save().catch((err) => {
            log.error('[OverlayStore] Coalesced save failed', err);
          });
        }
      }
    });
    return this.savingPromise;
  }

  private async performSave(): Promise<void> {
    const dir = path.dirname(this.storePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const payload = JSON.stringify(this.data, null, 2);
    const tmpPath = `${this.storePath}.tmp.${process.pid}.${Date.now()}`;

    let fd: number | undefined;
    try {
      fd = fs.openSync(tmpPath, 'w');
      fs.writeSync(fd, payload, 0, 'utf-8');
      try { fs.fsyncSync(fd); } catch { /* fsync may not be supported on some FS; rename still helps */ }
    } catch (err) {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      throw err;
    }
    try { fs.closeSync(fd); } catch { /* ignore */ }

    try {
      fs.renameSync(tmpPath, this.storePath);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      throw err;
    }
    this.dirty = false;
  }

  reload(): void {
    this.data = this.load();
    this.dirty = false;
    this._onDidChange.fire(undefined);
  }

  getMetadata(sessionId: string): OverlayMetadata | undefined {
    return this.data.sessions[sessionId];
  }

  getAllMetadata(): Record<string, OverlayMetadata> {
    return { ...this.data.sessions };
  }

  private ensureMetadata(sessionId: string): OverlayMetadata {
    if (!this.data.sessions[sessionId]) {
      const now = Date.now();
      this.data.sessions[sessionId] = {
        sessionId,
        tags: [],
        pinned: false,
        branches: [],
        relatedSessionIds: [],
        createdAt: now,
        updatedAt: now,
      };
    }
    return this.data.sessions[sessionId];
  }

  private touch(meta: OverlayMetadata): void {
    meta.updatedAt = Date.now();
    this.dirty = true;
  }

  async rename(sessionId: string, name: string): Promise<void> {
    const meta = this.ensureMetadata(sessionId);
    meta.customName = name || undefined;
    this.touch(meta);
    await this.save();
    this._onDidChange.fire(sessionId);
  }

  async setPin(sessionId: string, pinned: boolean): Promise<void> {
    const meta = this.ensureMetadata(sessionId);
    meta.pinned = pinned;
    this.touch(meta);
    await this.save();
    this._onDidChange.fire(sessionId);
  }

  async addTag(sessionId: string, tag: string): Promise<void> {
    const meta = this.ensureMetadata(sessionId);
    const normalized = tag.trim().toLowerCase();
    if (normalized && !meta.tags.includes(normalized)) {
      meta.tags.push(normalized);
      this.touch(meta);
      await this.save();
      this._onDidChange.fire(sessionId);
    }
  }

  async removeTag(sessionId: string, tag: string): Promise<void> {
    const meta = this.ensureMetadata(sessionId);
    const normalized = tag.trim().toLowerCase();
    const idx = meta.tags.indexOf(normalized);
    if (idx !== -1) {
      meta.tags.splice(idx, 1);
      this.touch(meta);
      await this.save();
      this._onDidChange.fire(sessionId);
    }
  }

  async setStatus(sessionId: string, status: SessionStatus): Promise<void> {
    const meta = this.ensureMetadata(sessionId);
    meta.status = status === 'none' ? undefined : status;
    this.touch(meta);
    await this.save();
    this._onDidChange.fire(sessionId);
  }

  async addBranch(sessionId: string, branch: string): Promise<void> {
    const meta = this.ensureMetadata(sessionId);
    const normalized = branch.trim();
    if (normalized && !meta.branches.includes(normalized)) {
      meta.branches.push(normalized);
      this.touch(meta);
      await this.save();
      this._onDidChange.fire(sessionId);
    }
  }

  async removeBranch(sessionId: string, branch: string): Promise<void> {
    const meta = this.ensureMetadata(sessionId);
    const idx = meta.branches.indexOf(branch.trim());
    if (idx !== -1) {
      meta.branches.splice(idx, 1);
      this.touch(meta);
      await this.save();
      this._onDidChange.fire(sessionId);
    }
  }

  async setJiraTicket(sessionId: string, ticket: string | undefined): Promise<void> {
    const meta = this.ensureMetadata(sessionId);
    const normalized = ticket?.trim().toUpperCase();
    meta.jiraTicket = normalized || undefined;
    this.touch(meta);
    await this.save();
    this._onDidChange.fire(sessionId);
  }

  async linkSessions(sessionIdA: string, sessionIdB: string): Promise<void> {
    const metaA = this.ensureMetadata(sessionIdA);
    const metaB = this.ensureMetadata(sessionIdB);

    if (!metaA.relatedSessionIds.includes(sessionIdB)) {
      metaA.relatedSessionIds.push(sessionIdB);
    }
    if (!metaB.relatedSessionIds.includes(sessionIdA)) {
      metaB.relatedSessionIds.push(sessionIdA);
    }

    this.touch(metaA);
    this.touch(metaB);
    await this.save();
    this._onDidChange.fire(undefined);
  }

  async unlinkSessions(sessionIdA: string, sessionIdB: string): Promise<void> {
    const metaA = this.data.sessions[sessionIdA];
    const metaB = this.data.sessions[sessionIdB];

    if (metaA) {
      metaA.relatedSessionIds = metaA.relatedSessionIds.filter(id => id !== sessionIdB);
      this.touch(metaA);
    }
    if (metaB) {
      metaB.relatedSessionIds = metaB.relatedSessionIds.filter(id => id !== sessionIdA);
      this.touch(metaB);
    }

    await this.save();
    this._onDidChange.fire(undefined);
  }

  async setNotes(sessionId: string, notes: string): Promise<void> {
    const meta = this.ensureMetadata(sessionId);
    meta.notes = notes || undefined;
    this.touch(meta);
    await this.save();
  }

  // --- Groups ---

  getGroup(groupId: string): SessionGroup | undefined {
    return this.data.groups[groupId];
  }

  getAllGroups(): SessionGroup[] {
    return Object.values(this.data.groups);
  }

  async createGroup(name: string, sessionIds: string[] = []): Promise<SessionGroup> {
    const id = `grp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const group: SessionGroup = { id, name, sessionIds: [...sessionIds] };
    this.data.groups[id] = group;

    for (const sid of sessionIds) {
      const meta = this.ensureMetadata(sid);
      meta.groupId = id;
      this.touch(meta);
    }

    this.dirty = true;
    await this.save();
    this._onDidChange.fire(undefined);
    return group;
  }

  async addToGroup(groupId: string, sessionId: string): Promise<void> {
    const group = this.data.groups[groupId];
    if (!group) { return; }

    if (!group.sessionIds.includes(sessionId)) {
      group.sessionIds.push(sessionId);
    }
    const meta = this.ensureMetadata(sessionId);
    meta.groupId = groupId;
    this.touch(meta);
    this.dirty = true;
    await this.save();
    this._onDidChange.fire(sessionId);
  }

  async removeFromGroup(groupId: string, sessionId: string): Promise<void> {
    const group = this.data.groups[groupId];
    if (!group) { return; }

    group.sessionIds = group.sessionIds.filter(id => id !== sessionId);
    const meta = this.data.sessions[sessionId];
    if (meta && meta.groupId === groupId) {
      meta.groupId = undefined;
      this.touch(meta);
    }
    this.dirty = true;
    await this.save();
    this._onDidChange.fire(sessionId);
  }

  async deleteGroup(groupId: string): Promise<void> {
    const group = this.data.groups[groupId];
    if (!group) { return; }

    for (const sid of group.sessionIds) {
      const meta = this.data.sessions[sid];
      if (meta && meta.groupId === groupId) {
        meta.groupId = undefined;
        this.touch(meta);
      }
    }

    delete this.data.groups[groupId];
    this.dirty = true;
    await this.save();
    this._onDidChange.fire(undefined);
  }

  async hideSession(sessionId: string): Promise<void> {
    if (!this.data.hiddenSessionIds) {
      this.data.hiddenSessionIds = [];
    }
    if (!this.data.hiddenSessionIds.includes(sessionId)) {
      this.data.hiddenSessionIds.push(sessionId);
      this.dirty = true;
      await this.save();
      this._onDidChange.fire(sessionId);
    }
  }

  async hideSessions(sessionIds: string[]): Promise<number> {
    if (!this.data.hiddenSessionIds) {
      this.data.hiddenSessionIds = [];
    }
    let added = 0;
    for (const id of sessionIds) {
      if (id && !this.data.hiddenSessionIds.includes(id)) {
        this.data.hiddenSessionIds.push(id);
        added++;
      }
    }
    if (added > 0) {
      this.dirty = true;
      await this.save();
      this._onDidChange.fire(undefined);
    }
    return added;
  }

  async unhideSession(sessionId: string): Promise<void> {
    if (!this.data.hiddenSessionIds) { return; }
    const idx = this.data.hiddenSessionIds.indexOf(sessionId);
    if (idx !== -1) {
      this.data.hiddenSessionIds.splice(idx, 1);
      this.dirty = true;
      await this.save();
      this._onDidChange.fire(sessionId);
    }
  }

  async unhideAll(): Promise<number> {
    const count = this.data.hiddenSessionIds?.length ?? 0;
    if (count > 0) {
      this.data.hiddenSessionIds = [];
      this.dirty = true;
      await this.save();
      this._onDidChange.fire(undefined);
    }
    return count;
  }

  getHiddenCount(): number {
    return this.data.hiddenSessionIds?.length ?? 0;
  }

  isHidden(sessionId: string): boolean {
    return this.data.hiddenSessionIds?.includes(sessionId) ?? false;
  }

  getHiddenIds(): Set<string> {
    return new Set(this.data.hiddenSessionIds ?? []);
  }

  getAllTags(): string[] {
    const tagSet = new Set<string>();
    for (const meta of Object.values(this.data.sessions)) {
      for (const tag of meta.tags) {
        tagSet.add(tag);
      }
    }
    return [...tagSet].sort();
  }

  // --- Todos ---

  private ensureTodos(): Record<string, Todo> {
    if (!this.data.todos) { this.data.todos = {}; }
    return this.data.todos;
  }

  getAllTodos(): Todo[] {
    return Object.values(this.ensureTodos());
  }

  getTodo(id: string): Todo | undefined {
    return this.ensureTodos()[id];
  }

  getTodosForSession(sessionId: string): Todo[] {
    return this.getAllTodos().filter(t => t.sessionIds.includes(sessionId));
  }

  async createTodo(title: string, notes?: string, sessionIds: string[] = []): Promise<Todo> {
    const todos = this.ensureTodos();
    const id = `todo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    const todo: Todo = {
      id,
      title: title.trim() || 'Untitled TODO',
      notes: notes?.trim() || undefined,
      status: 'open',
      sessionIds: [...new Set(sessionIds.filter(Boolean))],
      links: [],
      createdAt: now,
      updatedAt: now,
    };
    todos[id] = todo;
    this.dirty = true;
    await this.save();
    this._onDidChange.fire(undefined);
    return todo;
  }

  async updateTodo(
    id: string,
    patch: Partial<Pick<Todo, 'title' | 'notes' | 'status'>>,
  ): Promise<void> {
    const todo = this.ensureTodos()[id];
    if (!todo) { return; }
    if (patch.title !== undefined) {
      todo.title = patch.title.trim() || todo.title;
    }
    if (patch.notes !== undefined) {
      todo.notes = patch.notes.trim() || undefined;
    }
    if (patch.status !== undefined) {
      todo.status = patch.status;
    }
    todo.updatedAt = Date.now();
    this.dirty = true;
    await this.save();
    this._onDidChange.fire(undefined);
  }

  async addTodoLink(id: string, value: string): Promise<void> {
    const todo = this.ensureTodos()[id];
    if (!todo) { return; }
    if (!Array.isArray(todo.links)) { todo.links = []; }
    const trimmed = value.trim();
    if (!trimmed) { return; }
    todo.links.push(trimmed);
    todo.updatedAt = Date.now();
    this.dirty = true;
    await this.save();
    this._onDidChange.fire(undefined);
  }

  async updateTodoLinkAt(id: string, index: number, value: string): Promise<void> {
    const todo = this.ensureTodos()[id];
    if (!todo) { return; }
    if (!Array.isArray(todo.links)) { todo.links = []; }
    if (index < 0 || index >= todo.links.length) { return; }
    const trimmed = value.trim();
    if (!trimmed) {
      todo.links.splice(index, 1);
    } else {
      todo.links[index] = trimmed;
    }
    todo.updatedAt = Date.now();
    this.dirty = true;
    await this.save();
    this._onDidChange.fire(undefined);
  }

  async removeTodoLinkAt(id: string, index: number): Promise<void> {
    const todo = this.ensureTodos()[id];
    if (!todo) { return; }
    if (!Array.isArray(todo.links)) { todo.links = []; return; }
    if (index < 0 || index >= todo.links.length) { return; }
    todo.links.splice(index, 1);
    todo.updatedAt = Date.now();
    this.dirty = true;
    await this.save();
    this._onDidChange.fire(undefined);
  }

  async setTodoStatus(id: string, status: TodoStatus): Promise<void> {
    await this.updateTodo(id, { status });
  }

  async deleteTodo(id: string): Promise<void> {
    const todos = this.ensureTodos();
    if (!todos[id]) { return; }
    delete todos[id];
    this.dirty = true;
    await this.save();
    this._onDidChange.fire(undefined);
  }

  async attachSessionToTodo(todoId: string, sessionId: string): Promise<void> {
    const todo = this.ensureTodos()[todoId];
    if (!todo || !sessionId) { return; }
    if (!todo.sessionIds.includes(sessionId)) {
      todo.sessionIds.push(sessionId);
      todo.updatedAt = Date.now();
      this.dirty = true;
      await this.save();
      this._onDidChange.fire(sessionId);
    }
  }

  async detachSessionFromTodo(todoId: string, sessionId: string): Promise<void> {
    const todo = this.ensureTodos()[todoId];
    if (!todo) { return; }
    const idx = todo.sessionIds.indexOf(sessionId);
    if (idx !== -1) {
      todo.sessionIds.splice(idx, 1);
      todo.updatedAt = Date.now();
      this.dirty = true;
      await this.save();
      this._onDidChange.fire(sessionId);
    }
  }

  dispose(): void {
    if (this.dirty && this.loadState !== 'quarantine-failed') {
      try {
        // Reuse the atomic write path even on shutdown so a kill -9 mid
        // dispose can't truncate the file.
        const dir = path.dirname(this.storePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        const payload = JSON.stringify(this.data, null, 2);
        const tmpPath = `${this.storePath}.tmp.${process.pid}.${Date.now()}`;
        const fd = fs.openSync(tmpPath, 'w');
        try {
          fs.writeSync(fd, payload, 0, 'utf-8');
          try { fs.fsyncSync(fd); } catch { /* best effort */ }
        } finally {
          try { fs.closeSync(fd); } catch { /* ignore */ }
        }
        fs.renameSync(tmpPath, this.storePath);
      } catch (err) {
        log.error('[OverlayStore] dispose() failed to flush dirty data', err);
      }
    }
    this._onDidChange.dispose();
  }
}
