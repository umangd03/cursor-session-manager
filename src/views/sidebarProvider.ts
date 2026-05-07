import * as vscode from 'vscode';
import { SessionManager, SessionChange } from '../services/sessionManager';
import { OverlayStore } from '../services/overlayStore';
import { openSession, openSessionAsDocument } from '../services/sessionOpener';
import { Session } from '../models/types';
import { log } from '../services/logger';
import { configureJiraBaseUrl, getJiraBaseUrl, openJiraTicket } from '../services/jiraLinker';

export class SessionSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'cursorSessions.sidebar';

  private view?: vscode.WebviewView;
  private currentWorkspaceOnly = false;
  private activePollTimer?: NodeJS.Timeout;
  private currentActiveSessionId?: string;
  private activePollConsecutiveFailures = 0;
  /**
   * Guard against polling re-entry. The DB read can take longer than the
   * poll interval (especially when sqlite3 is briefly contended), and
   * without a guard `setInterval` would spawn a new child process every
   * 2s while the previous one hadn't finished, fanning out tens of
   * processes and pushing CPU through the roof.
   */
  private activePollInFlight = false;
  private readonly ACTIVE_POLL_INTERVAL_MS = 2000;
  private readonly ACTIVE_POLL_MAX_FAILURES = 10;

  /**
   * Disposables we own (event subscriptions registered against
   * collaborators). Tracked so `dispose()` can drop our listeners and
   * avoid leaks across reload-window cycles.
   */
  private disposables: vscode.Disposable[] = [];
  /** Disposables tied to the lifetime of one resolved webview view. */
  private viewDisposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly sessionManager: SessionManager,
    private readonly overlay: OverlayStore,
  ) {
    this.disposables.push(
      sessionManager.onDidChange((change) => this.handleSessionChange(change)),
    );
  }

  /**
   * React to overlay-driven changes without a full sidebar reload when we
   * can. The webview keeps its scroll position and any expanded UI state,
   * which avoids the "entire page refreshes on every status change" UX
   * complaint.
   */
  private handleSessionChange(change: SessionChange): void {
    if (!this.view) { return; }
    if (change.kind === 'patch') {
      this.view.webview.postMessage({
        type: 'sessionPatch',
        session: change.session,
        tags: this.sessionManager.getAllTags(),
        todoCountBySession: this.buildTodoCountBySession(),
      });
      return;
    }
    if (change.kind === 'remove') {
      this.view.webview.postMessage({
        type: 'sessionRemove',
        sessionId: change.sessionId,
        tags: this.sessionManager.getAllTags(),
        hiddenCount: this.overlay.getHiddenCount(),
      });
      return;
    }
    void this.sendRefresh();
  }

  private getCurrentWorkspacePath(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) { return undefined; }
    return folders[0].uri.fsPath;
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    log.info('resolveWebviewView called');
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);
    log.info('webview HTML set');

    this.viewDisposables.push(webviewView.webview.onDidReceiveMessage(async (msg) => {
      // Top-level guard: a malformed payload, an unhandled rejection
      // inside a handler, or an exception thrown from VS Code APIs
      // should never crash the message loop or leave the user staring
      // at a half-applied operation. Log it loudly so we can debug,
      // and surface a non-fatal toast.
      try {
        if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
          log.error('webview message rejected: malformed payload');
          return;
        }
        log.info(`webview message received: ${msg.type}`);
        await this.dispatchWebviewMessage(msg);
      } catch (err) {
        log.error(`webview message handler threw for type=${msg?.type ?? '<unknown>'}`, err);
        const detail = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(
          `Cursor Session Manager: ${msg?.type ?? 'message'} failed: ${detail}`,
        );
      }
    }));

    this.configDisposable?.dispose();
    this.configDisposable = vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('cursorSessions.jiraBaseUrl')) {
        void this.sendRefresh();
      }
    });

    if (webviewView.visible) {
      this.startActiveSessionPolling();
    }
    // Drop our background work whenever the user collapses the sidebar
    // or switches activity bar tabs — otherwise we'd keep hitting Cursor's
    // SQLite databases for a view nobody's looking at, which is both
    // wasted I/O and a real source of file-locking contention with the
    // host Cursor process.
    this.viewDisposables.push(
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) {
          this.startActiveSessionPolling();
        } else {
          this.stopActiveSessionPolling();
        }
      }),
    );
    this.viewDisposables.push(
      webviewView.onDidDispose(() => {
        this.stopActiveSessionPolling();
        this.disposeViewSubscriptions();
        this.view = undefined;
      }),
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async dispatchWebviewMessage(msg: any): Promise<void> {
    switch (msg.type) {
        case 'ready':
          await this.sendRefresh();
          break;
        case 'refresh':
          this.sessionManager.invalidateCache();
          await this.sendRefresh();
          break;
        case 'search':
          await this.handleSearch(msg.query, msg.scope);
          break;
        case 'pin':
          await this.overlay.setPin(msg.sessionId, msg.pinned);
          break;
        case 'rename':
          await this.handleRename(msg.sessionId);
          break;
        case 'tag':
          await this.handleTag(msg.sessionId);
          break;
        case 'removeTag':
          await this.overlay.removeTag(msg.sessionId, msg.tag);
          break;
        case 'setStatus':
          await this.handleSetStatus(msg.sessionId);
          break;
        case 'addBranch':
          await this.handleAddBranch(msg.sessionId);
          break;
        case 'removeBranch':
          await this.overlay.removeBranch(msg.sessionId, msg.branch);
          break;
        case 'export':
          await this.handleExport(msg.sessionId, msg.format);
          break;
        case 'link':
          await this.handleLink(msg.sessionId);
          break;
        case 'openSession':
          await this.handleOpenSession(msg.sessionId);
          break;
        case 'viewSession':
          await this.handleViewSession(msg.sessionId);
          break;
        case 'previewSession':
          await this.handlePreviewSession(msg.sessionId);
          break;
        case 'filterByTag':
          await this.handleFilterByTag(msg.tag);
          break;
        case 'toggleWorkspaceFilter':
          this.currentWorkspaceOnly = msg.enabled;
          await this.sendRefresh();
          break;
        case 'deleteSession':
          await this.handleDeleteSession(msg.sessionId);
          break;
        case 'deleteSessions':
          await this.handleDeleteMultiple(msg.sessionIds);
          break;
        case 'restoreDeleted':
          await this.handleRestoreDeleted();
          break;
        case 'setJiraTicket':
          await this.handleSetJiraTicket(msg.sessionId);
          break;
        case 'clearJiraTicket':
          if (typeof msg.sessionId === 'string' && msg.sessionId.length > 0) {
            await this.overlay.setJiraTicket(msg.sessionId, undefined);
          }
          break;
        case 'openJira':
          await openJiraTicket(msg.ticket);
          break;
        case 'openJiraSettings':
          await configureJiraBaseUrl();
          break;
        case 'todoCreate':
          await this.handleTodoCreate(msg.title, msg.notes, msg.sessionIds);
          break;
        case 'todoCreatePrompt':
          await this.handleTodoCreatePrompt();
          break;
        case 'todoRenamePrompt':
          await this.handleTodoRenamePrompt(msg.todoId);
          break;
        case 'todoUpdate':
          await this.handleTodoUpdate(msg.todoId, {
            title: msg.title,
            notes: msg.notes,
            status: msg.status,
          });
          break;
        case 'todoDelete':
          await this.handleTodoDelete(msg.todoId);
          break;
        case 'todoSetStatus':
          await this.handleTodoSetStatus(msg.todoId);
          break;
        case 'todoAttachSession':
          await this.handleTodoAttachSession(msg.todoId);
          break;
        case 'todoDetachSession':
          if (typeof msg.todoId === 'string' && typeof msg.sessionId === 'string') {
            await this.overlay.detachSessionFromTodo(msg.todoId, msg.sessionId);
          }
          break;
        case 'todoQuickCreateForSession':
          await this.handleTodoQuickCreateForSession(msg.sessionId);
          break;
        case 'todoAddLink':
          await this.handleTodoAddLink(msg.todoId);
          break;
        case 'todoEditLinkAt':
          await this.handleTodoEditLinkAt(msg.todoId, msg.index);
          break;
        case 'todoRemoveLinkAt':
          if (typeof msg.todoId === 'string' && typeof msg.index === 'number') {
            await this.overlay.removeTodoLinkAt(msg.todoId, msg.index);
          }
          break;
        case 'todoOpenLink':
          if (typeof msg.url === 'string' && msg.url.length > 0) {
            await this.openLinkBestEffort(msg.url);
          }
          break;
        case 'attachSessionToTodo':
          await this.handleAttachSessionToTodo(msg.sessionId);
          break;
        case 'requestTodos':
          await this.sendTodos();
          break;
        default:
          log.error(`webview message dispatcher: unknown type=${String(msg.type)}`);
          break;
      }
  }

  private configDisposable?: vscode.Disposable;

  private disposeViewSubscriptions(): void {
    for (const d of this.viewDisposables.splice(0)) {
      try { d.dispose(); } catch { /* ignore individual failures */ }
    }
  }

  dispose(): void {
    this.configDisposable?.dispose();
    this.stopActiveSessionPolling();
    this.disposeViewSubscriptions();
    for (const d of this.disposables.splice(0)) {
      try { d.dispose(); } catch { /* ignore individual failures */ }
    }
  }

  private startActiveSessionPolling(): void {
    this.stopActiveSessionPolling();
    void this.pollActiveSession();
    this.activePollTimer = setInterval(
      () => { void this.pollActiveSession(); },
      this.ACTIVE_POLL_INTERVAL_MS,
    );
  }

  private stopActiveSessionPolling(): void {
    if (this.activePollTimer) {
      clearInterval(this.activePollTimer);
      this.activePollTimer = undefined;
    }
    // Don't reset activePollInFlight; the in-flight call still has to
    // resolve before we let another start.
  }

  private async pollActiveSession(): Promise<void> {
    if (!this.view) { return; }
    if (this.activePollInFlight) {
      // Previous tick is still talking to sqlite3; skip this one rather
      // than fanning out a parallel child process.
      return;
    }
    this.activePollInFlight = true;
    try {
      const folders = vscode.workspace.workspaceFolders ?? [];
      const folderPaths = folders.map(f => f.uri.fsPath);
      const activeId = await this.sessionManager.getActiveSessionId(folderPaths);
      this.activePollConsecutiveFailures = 0;
      if (!this.view) { return; }
      if (activeId !== this.currentActiveSessionId) {
        this.currentActiveSessionId = activeId;
        this.view.webview.postMessage({ type: 'activeSession', sessionId: activeId ?? null });
      }
    } catch (err) {
      this.activePollConsecutiveFailures += 1;
      // Log only the first few; otherwise we drown the output channel and
      // make the real startup/sendRefresh log lines impossible to find.
      if (this.activePollConsecutiveFailures <= 3) {
        log.error('pollActiveSession failed', err);
      }
      if (this.activePollConsecutiveFailures === this.ACTIVE_POLL_MAX_FAILURES) {
        log.error(
          `pollActiveSession: giving up after ${this.ACTIVE_POLL_MAX_FAILURES} consecutive failures; ` +
          'active-session highlighting disabled until extension reload',
        );
        this.stopActiveSessionPolling();
      }
    } finally {
      this.activePollInFlight = false;
    }
  }

  /**
   * Track whether we've shipped at least one successful `sessions` payload
   * to the webview. After that, subsequent refreshes shouldn't flash the
   * skeleton — the webview already has data on screen and the user just
   * wants the new values to appear.
   */
  private hasSentInitialSessions = false;
  /**
   * Monotonically increasing request id for sendRefresh. If a newer
   * refresh is started while an older one is still in flight, the older
   * one will see `requestId !== this.refreshSequence` when it finishes
   * and silently drop its payload instead of overwriting fresher data.
   */
  private refreshSequence = 0;

  private async sendRefresh(): Promise<void> {
    if (!this.view) { return; }
    const requestId = ++this.refreshSequence;
    if (!this.hasSentInitialSessions) {
      this.view.webview.postMessage({ type: 'loading' });
    }
    try {
      log.info(`sendRefresh[#${requestId}]: fetching sessions...`);
      const filter: import('../models/types').SessionFilter = {};
      if (this.currentWorkspaceOnly) {
        filter.workspacePath = this.getCurrentWorkspacePath();
      }
      const sessions = await this.sessionManager.getSessions({ filter });
      if (requestId !== this.refreshSequence) {
        log.info(`sendRefresh[#${requestId}]: stale (latest is #${this.refreshSequence}); dropping`);
        return;
      }
      log.info(`sendRefresh[#${requestId}]: got ${sessions.length} sessions`);
      const tags = this.sessionManager.getAllTags();
      const groups = await this.sessionManager.getGroups();
      if (requestId !== this.refreshSequence) {
        log.info(`sendRefresh[#${requestId}]: stale after groups; dropping`);
        return;
      }
      const wsPath = this.getCurrentWorkspacePath();
      log.info(`sendRefresh[#${requestId}]: posting to webview (${tags.length} tags, ${groups.length} groups)`);
      const hiddenCount = this.overlay.getHiddenCount();
      const todoCountBySession = this.buildTodoCountBySession();
      if (!this.view) { return; }
      this.view.webview.postMessage({
        type: 'sessions', sessions, tags, groups,
        workspaceOnly: this.currentWorkspaceOnly,
        hasWorkspace: !!wsPath,
        hiddenCount,
        jiraBaseUrl: getJiraBaseUrl(),
        activeSessionId: this.currentActiveSessionId ?? null,
        todoCountBySession,
      });
      this.hasSentInitialSessions = true;
      await this.sendTodos();
      log.info(`sendRefresh[#${requestId}]: done`);
    } catch (err) {
      log.error(`sendRefresh[#${requestId}] failed`, err);
      if (this.view && requestId === this.refreshSequence) {
        this.view.webview.postMessage({ type: 'error', message: String(err) });
      }
    }
  }

  private async sendTodos(): Promise<void> {
    if (!this.view) { return; }
    try {
      const todos = await this.sessionManager.getTodosWithSessionTitles();
      this.view.webview.postMessage({ type: 'todos', todos });
    } catch (err) {
      log.error('sendTodos failed', err);
    }
  }

  private async handleTodoCreate(
    rawTitle: unknown,
    rawNotes: unknown,
    rawSessionIds: unknown,
  ): Promise<void> {
    const title = typeof rawTitle === 'string' ? rawTitle.trim() : '';
    if (!title) { return; }
    const notes = typeof rawNotes === 'string' ? rawNotes : undefined;
    const sessionIds = Array.isArray(rawSessionIds)
      ? rawSessionIds.filter((s): s is string => typeof s === 'string')
      : [];
    await this.overlay.createTodo(title, notes, sessionIds);
  }

  private async handleTodoCreatePrompt(): Promise<void> {
    const title = await vscode.window.showInputBox({
      prompt: 'New TODO title',
      placeHolder: 'e.g., Investigate flaky auth flow',
    });
    if (!title?.trim()) { return; }
    await this.overlay.createTodo(title.trim());
  }

  private async handleTodoRenamePrompt(todoId: unknown): Promise<void> {
    if (typeof todoId !== 'string' || !todoId) { return; }
    const todo = this.overlay.getTodo(todoId);
    if (!todo) { return; }
    const next = await vscode.window.showInputBox({
      prompt: 'Rename TODO',
      value: todo.title,
      placeHolder: 'TODO title',
    });
    if (next === undefined) { return; }
    const trimmed = next.trim();
    if (!trimmed || trimmed === todo.title) { return; }
    await this.overlay.updateTodo(todoId, { title: trimmed });
  }

  private async handleTodoUpdate(
    todoId: unknown,
    patch: { title?: unknown; notes?: unknown; status?: unknown },
  ): Promise<void> {
    if (typeof todoId !== 'string' || !todoId) { return; }
    const update: { title?: string; notes?: string; status?: import('../models/types').TodoStatus } = {};
    if (typeof patch.title === 'string') { update.title = patch.title; }
    if (typeof patch.notes === 'string') { update.notes = patch.notes; }
    if (typeof patch.status === 'string') {
      const allowed = ['open', 'in_progress', 'done', 'archived'] as const;
      if ((allowed as readonly string[]).includes(patch.status)) {
        update.status = patch.status as import('../models/types').TodoStatus;
      }
    }
    await this.overlay.updateTodo(todoId, update);
  }

  private async handleTodoDelete(todoId: unknown): Promise<void> {
    if (typeof todoId !== 'string' || !todoId) { return; }
    const todo = this.overlay.getTodo(todoId);
    if (!todo) { return; }
    const choice = await vscode.window.showWarningMessage(
      `Delete TODO "${todo.title}"?`,
      { modal: true },
      'Delete',
    );
    if (choice !== 'Delete') { return; }
    await this.overlay.deleteTodo(todoId);
  }

  private async handleTodoSetStatus(todoId: unknown): Promise<void> {
    if (typeof todoId !== 'string' || !todoId) { return; }
    const { TODO_STATUS_LABELS } = await import('../models/types');
    const entries = Object.entries(TODO_STATUS_LABELS) as [
      import('../models/types').TodoStatus,
      string,
    ][];
    const picks = entries.map(([key, label]) => ({ label, statusKey: key }));
    const selected = await vscode.window.showQuickPick(picks, {
      placeHolder: 'Set TODO status',
    });
    if (selected) {
      await this.overlay.setTodoStatus(todoId, selected.statusKey);
    }
  }

  private async handleTodoAttachSession(todoId: unknown): Promise<void> {
    if (typeof todoId !== 'string' || !todoId) { return; }
    const todo = this.overlay.getTodo(todoId);
    if (!todo) { return; }
    const sessions = await this.sessionManager.getSessions();
    const attached = new Set(todo.sessionIds);
    const items = sessions
      .filter(s => !attached.has(s.id))
      .map(s => ({ label: s.displayName, description: s.jiraTicket ?? '', sessionId: s.id }));
    if (items.length === 0) {
      void vscode.window.showInformationMessage('All sessions are already attached to this TODO.');
      return;
    }
    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Attach session to TODO',
      matchOnDescription: true,
    });
    if (selected) {
      await this.overlay.attachSessionToTodo(todoId, selected.sessionId);
    }
  }

  private async handleAttachSessionToTodo(sessionId: unknown): Promise<void> {
    if (typeof sessionId !== 'string' || !sessionId) { return; }
    const session = await this.sessionManager.getSession(sessionId);
    if (!session) { return; }

    const allTodos = this.overlay.getAllTodos().filter(t => t.status !== 'archived');
    const NEW_TODO = '__new__';
    const items: vscode.QuickPickItem[] = [
      { label: '$(add) New TODO…', description: 'Create a new TODO and attach this session', detail: NEW_TODO },
      ...allTodos.map(t => ({
        label: t.title,
        description: `${t.status} · ${t.sessionIds.length} sessions`,
        detail: t.id,
      })),
    ];

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: `Attach "${session.displayName}" to TODO`,
    });
    if (!picked) { return; }
    if (picked.detail === NEW_TODO) {
      await this.handleTodoQuickCreateForSession(sessionId);
      return;
    }
    if (picked.detail) {
      await this.overlay.attachSessionToTodo(picked.detail, sessionId);
    }
  }

  private async handleTodoQuickCreateForSession(sessionId: unknown): Promise<void> {
    const sid = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined;
    const title = await vscode.window.showInputBox({
      prompt: 'TODO title',
      placeHolder: 'e.g., Investigate flaky auth flow',
    });
    if (!title?.trim()) { return; }
    await this.overlay.createTodo(title.trim(), undefined, sid ? [sid] : []);
  }

  private async handleTodoAddLink(todoId: unknown): Promise<void> {
    if (typeof todoId !== 'string' || !todoId) { return; }
    const value = await vscode.window.showInputBox({
      prompt: 'Add a link or reference',
      placeHolder: 'Webex / Slack / Zoom / GitHub PR / any text or URL',
    });
    if (value === undefined) { return; }
    const trimmed = value.trim();
    if (!trimmed) { return; }
    await this.overlay.addTodoLink(todoId, trimmed);
  }

  private async handleTodoEditLinkAt(todoId: unknown, index: unknown): Promise<void> {
    if (typeof todoId !== 'string' || !todoId) { return; }
    if (typeof index !== 'number') { return; }
    const todo = this.overlay.getTodo(todoId);
    if (!todo || !Array.isArray(todo.links)) { return; }
    const current = todo.links[index];
    if (current === undefined) { return; }
    const value = await vscode.window.showInputBox({
      prompt: 'Edit link (leave blank to remove)',
      value: current,
    });
    if (value === undefined) { return; }
    await this.overlay.updateTodoLinkAt(todoId, index, value);
  }

  /**
   * Best-effort open: try VS Code's external opener (which works for any URL
   * scheme it recognizes). If parsing fails or the OS rejects it, surface a
   * non-fatal info message and leave the entry intact for manual copy.
   */
  private async openLinkBestEffort(value: string): Promise<void> {
    const trimmed = value.trim();
    if (!trimmed) { return; }
    try {
      const uri = vscode.Uri.parse(trimmed, true);
      const ok = await vscode.env.openExternal(uri);
      if (!ok) {
        await vscode.env.clipboard.writeText(trimmed);
        void vscode.window.showInformationMessage(
          `Could not open "${trimmed}". Copied to clipboard.`,
        );
      }
    } catch {
      await vscode.env.clipboard.writeText(trimmed);
      void vscode.window.showInformationMessage(
        `"${trimmed}" is not a recognizable URL. Copied to clipboard.`,
      );
    }
  }

  private async handleSearch(query: unknown, scope?: unknown): Promise<void> {
    if (!this.view) { return; }
    // Tolerate any payload shape from the webview: a non-string query
    // would throw deep in `String#includes()` inside `SessionManager`.
    const normalizedQuery = typeof query === 'string' ? query : '';
    const normalizedScope: 'title' | 'all' = scope === 'title' ? 'title' : 'all';
    const results = await this.sessionManager.searchSessions(normalizedQuery, normalizedScope);
    const tags = this.sessionManager.getAllTags();
    this.view.webview.postMessage({
      type: 'sessions',
      sessions: results,
      tags,
      groups: [],
      jiraBaseUrl: getJiraBaseUrl(),
      todoCountBySession: this.buildTodoCountBySession(),
    });
  }

  private buildTodoCountBySession(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const t of this.overlay.getAllTodos()) {
      if (t.status === 'archived') { continue; }
      for (const sid of t.sessionIds) {
        counts[sid] = (counts[sid] ?? 0) + 1;
      }
    }
    return counts;
  }

  private async handleRename(sessionId: string): Promise<void> {
    const session = await this.sessionManager.getSession(sessionId);
    const current = session?.customName ?? session?.autoTitle ?? '';
    const name = await vscode.window.showInputBox({
      prompt: 'Enter a custom name for this session',
      value: current,
      placeHolder: 'e.g., Fix auth token refresh bug',
    });
    if (name !== undefined) {
      await this.overlay.rename(sessionId, name);
    }
  }

  private async handleTag(sessionId: string): Promise<void> {
    const existing = this.sessionManager.getAllTags();
    const tag = await vscode.window.showInputBox({
      prompt: 'Enter a tag (or pick from existing)',
      placeHolder: existing.length > 0 ? `Existing: ${existing.join(', ')}` : 'e.g., AISTUDIO-1234, bugfix, deepagent',
    });
    if (tag?.trim()) {
      await this.overlay.addTag(sessionId, tag.trim());
    }
  }

  private async handleSetStatus(sessionId: string): Promise<void> {
    const { SESSION_STATUS_LABELS } = await import('../models/types');
    const entries = Object.entries(SESSION_STATUS_LABELS) as [import('../models/types').SessionStatus, string][];
    const picks = entries
      .filter(([key]) => key !== 'none')
      .map(([key, label]) => ({ label, statusKey: key }));
    picks.unshift({ label: 'Clear status', statusKey: 'none' as import('../models/types').SessionStatus });

    const selected = await vscode.window.showQuickPick(picks, {
      placeHolder: 'Set session status',
    });

    if (selected) {
      await this.overlay.setStatus(sessionId, selected.statusKey);
    }
  }

  private async handleAddBranch(sessionId: string): Promise<void> {
    const branch = await vscode.window.showInputBox({
      prompt: 'Enter branch name',
      placeHolder: 'e.g., feature/auth, main, bugfix/AISTUDIO-1234',
    });
    if (branch?.trim()) {
      await this.overlay.addBranch(sessionId, branch.trim());
    }
  }

  private async handleExport(sessionId: string, format: 'markdown' | 'json'): Promise<void> {
    try {
      const content = await this.sessionManager.exportSession(sessionId, format);
      const ext = format === 'markdown' ? 'md' : 'json';
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(`session-export.${ext}`),
        filters: format === 'markdown'
          ? { 'Markdown': ['md'] }
          : { 'JSON': ['json'] },
      });
      if (uri) {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
        vscode.window.showInformationMessage(`Session exported to ${uri.fsPath}`);
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Export failed: ${err}`);
    }
  }

  private async handleLink(sessionId: string): Promise<void> {
    const sessions = await this.sessionManager.getSessions();
    const items = sessions
      .filter(s => s.id !== sessionId)
      .map(s => ({
        label: s.displayName,
        description: new Date(s.lastMessageAt).toLocaleDateString(),
        detail: s.metrics?.messageCount ? `${s.metrics.messageCount} messages` : undefined,
        sessionId: s.id,
      }));

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a session to link as related',
      canPickMany: true,
    });

    if (picked) {
      for (const p of picked) {
        await this.overlay.linkSessions(sessionId, p.sessionId);
      }
    }
  }

  private async handleOpenSession(sessionId: string): Promise<void> {
    const session = await this.sessionManager.getSession(sessionId);
    if (!session) { return; }
    await openSession(session);
  }

  private async handleViewSession(sessionId: string): Promise<void> {
    if (!this.view) { return; }
    const session = await this.sessionManager.getSession(sessionId);
    if (!session) { return; }

    const related = await this.sessionManager.getRelatedSessions(sessionId);
    this.view.webview.postMessage({ type: 'sessionDetail', session, related });
  }

  private async handlePreviewSession(sessionId: string): Promise<void> {
    const session = await this.sessionManager.getSession(sessionId);
    if (!session) { return; }
    await openSessionAsDocument(session, true);
  }

  private async handleDeleteSession(sessionId: string): Promise<void> {
    const session = await this.sessionManager.getSession(sessionId);
    const name = session?.displayName ?? 'this session';
    const hasTags = session && session.tags.length > 0;
    const detail = hasTags
      ? `Tags: ${session.tags.join(', ')}\n\nYou can restore deleted sessions later via Command Palette > "Sessions: Restore Deleted Sessions".`
      : 'You can restore deleted sessions later via Command Palette > "Sessions: Restore Deleted Sessions".';
    const answer = await vscode.window.showWarningMessage(
      `Delete "${name}" from your session list?`,
      { modal: true, detail },
      'Delete',
    );
    if (answer === 'Delete') {
      await this.overlay.hideSession(sessionId);
      this.sessionManager.invalidateCache();
      await this.sendRefresh();
      vscode.window.showInformationMessage(
        `Deleted "${name}". Use "Sessions: Restore Deleted Sessions" to undo.`,
      );
    }
  }

  private async handleDeleteMultiple(sessionIds: string[]): Promise<void> {
    const ids = Array.isArray(sessionIds)
      ? sessionIds.filter(id => typeof id === 'string' && id.length > 0)
      : [];
    if (ids.length === 0) { return; }
    const answer = await vscode.window.showWarningMessage(
      `Delete ${ids.length} session(s) from your list?`,
      {
        modal: true,
        detail: 'You can restore them later via Command Palette > "Sessions: Restore Deleted Sessions".',
      },
      'Delete',
    );
    if (answer !== 'Delete') { return; }
    const count = await this.overlay.hideSessions(ids);
    this.sessionManager.invalidateCache();
    await this.sendRefresh();
    vscode.window.showInformationMessage(`Deleted ${count} session(s).`);
  }

  private async handleSetJiraTicket(sessionId: string): Promise<void> {
    const session = await this.sessionManager.getSession(sessionId);
    const current = session?.jiraTicket ?? '';
    const ticket = await vscode.window.showInputBox({
      prompt: 'Enter JIRA ticket key (leave blank to unset)',
      placeHolder: 'e.g., AISTUDIO-1234',
      value: current,
      validateInput: (val) => {
        const trimmed = val.trim();
        if (!trimmed) { return undefined; }
        return /^[A-Za-z][A-Za-z0-9]+-\d+$/.test(trimmed)
          ? undefined
          : 'Expected format like PROJ-1234';
      },
    });
    if (ticket === undefined) { return; }
    await this.overlay.setJiraTicket(sessionId, ticket.trim() || undefined);
  }

  private async handleRestoreDeleted(): Promise<void> {
    const count = this.overlay.getHiddenCount();
    if (count === 0) { return; }
    const answer = await vscode.window.showInformationMessage(
      `Restore ${count} deleted session(s)?`,
      'Restore All', 'Cancel',
    );
    if (answer === 'Restore All') {
      await this.overlay.unhideAll();
      this.sessionManager.invalidateCache();
      await this.sendRefresh();
      vscode.window.showInformationMessage(`Restored ${count} session(s).`);
    }
  }

  private async handleFilterByTag(tag: string): Promise<void> {
    const sessions = await this.sessionManager.getSessions({
      filter: { tags: [tag] },
    });
    const tags = this.sessionManager.getAllTags();
    if (this.view) {
      this.view.webview.postMessage({
        type: 'sessions',
        sessions,
        tags,
        groups: [],
        activeFilter: tag,
        jiraBaseUrl: getJiraBaseUrl(),
        todoCountBySession: this.buildTodoCountBySession(),
      });
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();

    return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sessions</title>
  <style>
    :root {
      --bg: var(--vscode-sideBar-background);
      --fg: var(--vscode-sideBar-foreground);
      --input-bg: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground);
      --input-border: var(--vscode-input-border, transparent);
      --badge-bg: var(--vscode-badge-background);
      --badge-fg: var(--vscode-badge-foreground);
      --hover-bg: var(--vscode-list-hoverBackground);
      --active-bg: var(--vscode-list-activeSelectionBackground);
      --active-fg: var(--vscode-list-activeSelectionForeground);
      --border: var(--vscode-panel-border, rgba(128,128,128,0.2));
      --link: var(--vscode-textLink-foreground);
      --dim: var(--vscode-descriptionForeground);
      --focus: var(--vscode-focusBorder);
      --success: var(--vscode-testing-iconPassed, #4ec9b0);
      --warn: var(--vscode-editorWarning-foreground, #cca700);
      --error: var(--vscode-errorForeground, #f14c4c);
      --card-radius: 6px;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: var(--bg);
      color: var(--fg);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      padding: 0;
      overflow-x: hidden;
      line-height: 1.4;
    }

    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background, rgba(128,128,128,0.3)); border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground, rgba(128,128,128,0.5)); }
    ::-webkit-scrollbar-track { background: transparent; }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes shimmer {
      0% { background-position: -200% 0; }
      100% { background-position: 200% 0; }
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes slideDown {
      from { opacity: 0; max-height: 0; }
      to { opacity: 1; max-height: 600px; }
    }

    /* --- Tabs / Panels --- */
    .tab-bar {
      position: sticky;
      top: 0;
      z-index: 11;
      display: flex;
      background: var(--bg);
      border-bottom: 1px solid var(--border);
    }
    .tab-btn {
      flex: 1;
      background: none;
      border: none;
      color: var(--dim);
      padding: 8px 10px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      font-family: inherit;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: color 0.12s, border-color 0.12s;
    }
    .tab-btn:hover { color: var(--fg); }
    .tab-btn.active {
      color: var(--fg);
      border-bottom-color: var(--link);
    }
    .tab-count {
      font-size: 10px;
      font-weight: 600;
      background: color-mix(in srgb, var(--fg) 12%, transparent);
      color: var(--fg);
      padding: 1px 6px;
      border-radius: 8px;
      min-width: 14px;
      line-height: 1.4;
    }
    .panel { display: none; }
    .panel.active { display: block; }
    .panel .toolbar { top: 32px; } /* sit below the tab bar when sticky */
    /* When showing a detail view, hide the list toolbar so it doesn't waste
       vertical space and so the sticky detail-header doesn't fight with the
       sticky toolbar for the same top:32px slot. */
    .panel.in-detail > .toolbar { display: none; }

    /* --- Toolbar --- */
    .toolbar {
      position: sticky;
      top: 0;
      z-index: 10;
      background: var(--bg);
      padding: 10px 10px 8px;
      border-bottom: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .toolbar-row {
      display: flex;
      gap: 4px;
      align-items: center;
    }
    .search-wrap {
      flex: 1;
      position: relative;
      display: flex;
      align-items: stretch;
      background: var(--input-bg);
      border: 1px solid var(--input-border);
      border-radius: 4px;
      transition: border-color 0.15s;
      overflow: hidden;
      min-width: 0;
    }
    .search-wrap:focus-within { border-color: var(--focus); }
    .search-input {
      flex: 1;
      min-width: 0;
      background: transparent;
      color: var(--input-fg);
      border: none;
      padding: 5px 6px 5px 26px;
      font-size: 12px;
      outline: none;
    }
    .search-icon {
      position: absolute;
      left: 8px;
      top: 50%;
      transform: translateY(-50%);
      font-size: 12px;
      color: var(--dim);
      pointer-events: none;
    }
    .scope-seg {
      display: inline-flex;
      align-items: stretch;
      border-left: 1px solid var(--input-border);
      flex-shrink: 0;
    }
    .scope-seg-btn {
      background: none;
      border: none;
      padding: 0 8px;
      font-size: 10px;
      font-family: inherit;
      color: var(--dim);
      cursor: pointer;
      letter-spacing: 0.3px;
      text-transform: uppercase;
      transition: background 0.15s, color 0.15s;
      white-space: nowrap;
    }
    .scope-seg-btn + .scope-seg-btn { border-left: 1px solid var(--input-border); }
    .scope-seg-btn:hover { color: var(--fg); background: var(--hover-bg); }
    .scope-seg-btn.active {
      color: var(--success);
      background: rgba(78,201,176,0.14);
      font-weight: 600;
    }
    .scope-seg-btn:focus-visible { outline: 1px solid var(--focus); outline-offset: -1px; }
    .icon-btn {
      background: none;
      border: none;
      color: var(--dim);
      cursor: pointer;
      padding: 5px;
      border-radius: 4px;
      font-size: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s;
      flex-shrink: 0;
    }
    .icon-btn:hover { background: var(--hover-bg); color: var(--fg); }
    .icon-btn.spinning { animation: spin 0.6s linear infinite; }
    .sort-select {
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border);
      border-radius: 4px;
      padding: 4px 6px;
      font-size: 11px;
      outline: none;
      cursor: pointer;
    }
    .sort-select:focus { border-color: var(--focus); }
    .toggle-btn {
      background: none;
      border: 1px solid var(--border);
      color: var(--dim);
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-family: inherit;
      transition: all 0.15s;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .toggle-btn:hover { background: var(--hover-bg); color: var(--fg); }
    .toggle-btn.active {
      background: rgba(78,201,176,0.12);
      color: var(--success);
      border-color: var(--success);
    }

    /* --- Counters --- */
    .counter-row {
      display: flex;
      gap: 10px;
      font-size: 11px;
      color: var(--dim);
      padding: 0 2px;
    }
    .counter-row span { display: flex; align-items: center; gap: 3px; }

    /* --- Tag bar --- */
    .tag-bar { 
      display: flex; 
      flex-wrap: nowrap; 
      gap: 4px; 
      overflow-x: auto; 
      padding-bottom: 4px; 
      scrollbar-width: none; /* Firefox */
    }
    .tag-bar::-webkit-scrollbar { display: none; } /* Chrome/Safari */
    .tag-chip {
      background: var(--badge-bg);
      color: var(--badge-fg);
      font-size: 10px;
      padding: 2px 8px;
      border-radius: 10px;
      cursor: pointer;
      border: 1px solid transparent;
      white-space: nowrap;
      transition: all 0.15s;
      font-weight: 500;
    }
    .tag-chip:hover { opacity: 0.85; }
    .tag-chip.active { border-color: var(--link); box-shadow: 0 0 0 1px var(--link); }

    /* --- Filter banner --- */
    .filter-banner {
      display: none;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      color: var(--dim);
      padding: 4px 8px;
      background: rgba(128,128,128,0.08);
      border-radius: 4px;
    }
    .filter-banner.visible { display: flex; }
    .filter-clear {
      color: var(--link);
      cursor: pointer;
      border: none;
      background: none;
      font-size: 11px;
      margin-left: auto;
    }
    .filter-clear:hover { text-decoration: underline; }

    /* --- Loading --- */
    .loading-state {
      padding: 16px 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .skeleton {
      height: 52px;
      border-radius: var(--card-radius);
      background: linear-gradient(90deg, rgba(128,128,128,0.06) 25%, rgba(128,128,128,0.12) 50%, rgba(128,128,128,0.06) 75%);
      background-size: 200% 100%;
      animation: shimmer 1.5s infinite ease-in-out;
    }

    /* --- Error / Empty --- */
    .state-msg {
      text-align: center;
      padding: 48px 20px;
      color: var(--dim);
    }
    .state-msg .state-icon { font-size: 32px; opacity: 0.4; margin-bottom: 10px; }
    .state-msg h3 { font-size: 13px; font-weight: 600; margin-bottom: 4px; color: var(--fg); }
    .state-msg p { font-size: 12px; line-height: 1.5; }
    .state-msg.error .state-icon { color: var(--error); opacity: 0.7; }

    /* --- Session list --- */
    .session-list { padding: 4px 0; }

    .time-group-label {
      font-size: 10px;
      font-weight: 700;
      color: var(--dim);
      padding: 12px 12px 4px;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .time-group-label::after {
      content: '';
      flex: 1;
      height: 1px;
      background: var(--border);
    }
    .group-count {
      font-weight: 400;
      opacity: 0.7;
    }

    /* --- Session card --- */
    .session-card {
      margin: 2px 6px;
      padding: 8px 10px;
      border-radius: var(--card-radius);
      cursor: pointer;
      border-left: 3px solid transparent;
      transition: background 0.12s, border-color 0.12s, transform 0.1s;
      animation: fadeIn 0.2s ease-out both;
      position: relative;
    }
    .session-card:hover,
    .session-card:focus-visible { background: var(--hover-bg); }
    .session-card:focus-visible { outline: 1px solid var(--focus); outline-offset: -1px; }
    .session-card:active { transform: scale(0.995); }
    .session-card.pinned { border-left-color: var(--link); }

    /* Currently focused session in Cursor (live tracked from native UI) */
    .session-card.active {
      background: color-mix(in srgb, var(--link) 16%, transparent);
      border-left-color: var(--success);
    }
    .session-card.active:hover,
    .session-card.active:focus-visible {
      background: color-mix(in srgb, var(--link) 22%, transparent);
    }
    .session-card.active::after {
      content: '';
      position: absolute;
      top: 50%;
      right: 8px;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--success);
      transform: translateY(-50%);
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--success) 30%, transparent);
      pointer-events: none;
    }
    body.select-mode .session-card.active::after,
    .session-card.active:hover::after { display: none; }

    .card-header {
      display: flex;
      align-items: center;
      gap: 6px;
      min-height: 20px;
    }
    .card-title {
      flex: 1;
      font-size: 12.5px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      line-height: 1.3;
    }
    .mode-badge {
      font-size: 9px;
      padding: 1px 5px;
      border-radius: 3px;
      font-weight: 600;
      text-transform: uppercase;
      flex-shrink: 0;
      letter-spacing: 0.3px;
    }
    .mode-badge.agent { background: rgba(78,201,176,0.15); color: var(--success); }
    .mode-badge.edit { background: rgba(204,167,0,0.15); color: var(--warn); }
    .pin-toggle {
      font-size: 11px;
      opacity: 0;
      cursor: pointer;
      flex-shrink: 0;
      transition: opacity 0.12s;
      padding: 2px;
    }
    .session-card:hover .pin-toggle,
    .session-card:focus-within .pin-toggle { opacity: 0.5; }
    .session-card:hover .pin-toggle:hover,
    .session-card:focus-within .pin-toggle:hover { opacity: 1; }
    .session-card.pinned .pin-toggle { opacity: 1; color: var(--link); }

    .card-subtitle {
      font-size: 11px;
      color: var(--dim);
      margin-top: 2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      opacity: 0.8;
    }
    .card-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 4px;
      font-size: 10.5px;
      color: var(--dim);
    }
    .meta-item {
      display: flex;
      align-items: center;
      gap: 3px;
    }
    .meta-dot { opacity: 0.4; }

    .card-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 3px;
      margin-top: 5px;
    }
    .card-tags .tag-chip { font-size: 9px; padding: 1px 6px; }
    .tag-remove {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-left: 3px;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      font-size: 9px;
      line-height: 1;
      cursor: pointer;
      opacity: 0.5;
      background: none;
      border: none;
      color: inherit;
      padding: 0;
    }
    .tag-remove:hover { opacity: 1; background: rgba(255,255,255,0.15); }

    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 10px;
      font-weight: 600;
      padding: 1px 7px;
      border-radius: 10px;
      flex-shrink: 0;
      cursor: pointer;
      border: 1px solid currentColor;
      background: color-mix(in srgb, currentColor 12%, transparent);
      transition: opacity 0.12s, background 0.12s;
      white-space: nowrap;
      line-height: 1.4;
      font-family: inherit;
    }
    .status-badge:hover { background: color-mix(in srgb, currentColor 20%, transparent); }
    .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
      background: currentColor;
    }

    .card-branches {
      display: flex;
      flex-wrap: wrap;
      gap: 3px;
      margin-top: 4px;
    }
    .branch-chip {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      font-size: 10px;
      color: var(--dim);
      background: none;
      padding: 1px 4px;
      border-radius: 3px;
      border: 1px solid var(--border);
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      cursor: default;
    }
    .branch-remove {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 9px;
      cursor: pointer;
      opacity: 0.5;
      margin-left: 2px;
      background: none;
      border: none;
      color: inherit;
      padding: 0;
      line-height: 1;
    }
    .branch-remove:hover { opacity: 1; }

    /* --- Hover actions --- */
    .card-actions {
      display: none;
      flex-wrap: wrap;
      gap: 3px;
      margin-top: 6px;
      padding-top: 6px;
      border-top: 1px solid var(--border);
      animation: fadeIn 0.15s ease-out;
    }
    .session-card:hover .card-actions,
    .session-card:focus-within .card-actions,
    .session-card:focus-visible .card-actions { display: flex; }
    .act-btn {
      -webkit-appearance: none;
      appearance: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 10.5px;
      line-height: 1.2;
      padding: 3px 8px;
      border-radius: 4px;
      border: 1px solid var(--border);
      background: none;
      color: var(--dim, var(--fg));
      cursor: pointer;
      transition: all 0.12s;
      font-family: inherit;
      text-indent: 0;
      white-space: nowrap;
    }
    .act-btn:hover { color: var(--fg); background: var(--hover-bg); border-color: var(--dim); }
    .act-btn.primary { background: rgba(128,128,128,0.08); color: var(--fg, currentColor); font-weight: 500; }
    .act-btn.primary:hover { background: rgba(128,128,128,0.18); }
    .act-btn.danger { color: var(--error, var(--fg)); }
    .act-btn.danger:hover { background: rgba(241,76,76,0.1); border-color: var(--error); }

    /* --- Restore banner --- */
    .restore-banner {
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 12px; margin: 8px 0 0;
      background: rgba(78,201,176,0.08); border: 1px solid rgba(78,201,176,0.25);
      border-radius: 6px; font-size: 11.5px; color: var(--dim);
    }
    .restore-banner .restore-btn {
      background: rgba(78,201,176,0.15); color: var(--success); border: 1px solid rgba(78,201,176,0.3);
      border-radius: 4px; padding: 3px 10px; font-size: 11px; cursor: pointer;
    }
    .restore-banner .restore-btn:hover {
      background: rgba(78,201,176,0.25);
    }

    /* --- Select mode --- */
    .select-bar {
      display: none;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      background: rgba(79,193,255,0.08);
      border: 1px solid rgba(79,193,255,0.3);
      border-radius: 4px;
      font-size: 11.5px;
      color: var(--fg);
    }
    .select-bar.active { display: flex; }
    .select-bar .select-count { font-weight: 600; }
    .select-bar .spacer { flex: 1; }
    .select-bar button {
      background: none;
      border: 1px solid var(--border);
      color: var(--fg);
      padding: 3px 10px;
      border-radius: 4px;
      font-size: 11px;
      font-family: inherit;
      cursor: pointer;
      transition: all 0.15s;
    }
    .select-bar button:hover { background: var(--hover-bg); }
    .select-bar button.primary-danger {
      background: rgba(241,76,76,0.1);
      color: var(--error);
      border-color: rgba(241,76,76,0.4);
    }
    .select-bar button.primary-danger:hover {
      background: rgba(241,76,76,0.18);
    }
    .select-bar button:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    .session-card.selectable { padding-left: 32px; }
    .session-card.selected {
      background: rgba(79,193,255,0.08);
      border-left-color: var(--link);
    }
    .session-checkbox {
      position: absolute;
      top: 50%;
      transform: translateY(-50%);
      left: 10px;
      width: 14px;
      height: 14px;
      border: 1.5px solid var(--dim);
      border-radius: 3px;
      display: none;
      align-items: center;
      justify-content: center;
      background: var(--bg);
      font-size: 10px;
      color: var(--link);
      font-weight: 700;
      line-height: 1;
    }
    body.select-mode .session-checkbox { display: flex; }
    body.select-mode .session-card { 
      cursor: pointer; 
      padding-left: 32px !important;
    }
    body.select-mode .session-card .pin-toggle,
    body.select-mode .session-card .card-actions,
    body.select-mode .session-card .status-badge,
    body.select-mode .session-card .tag-remove,
    body.select-mode .session-card .branch-remove,
    body.select-mode .session-card .jira-badge {
      pointer-events: none;
    }
    body.select-mode .session-card .card-actions { display: none !important; }
    .session-card.selected .session-checkbox {
      background: var(--link);
      border-color: var(--link);
      color: var(--bg);
    }

    /* --- Minimal Mode --- */
    body.minimal-mode .card-subtitle,
    body.minimal-mode .card-meta,
    body.minimal-mode .card-info,
    body.minimal-mode .card-branches,
    body.minimal-mode .card-tags {
      display: none !important;
    }
    body.minimal-mode .session-card {
      padding: 4px 8px;
    }
    body.minimal-mode .card-header {
      min-height: auto;
    }
    body.minimal-mode .card-actions {
      margin-top: 4px;
      padding-top: 4px;
    }

    /* --- JIRA / created date row --- */
    .card-info {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      margin-top: 5px;
      font-size: 10.5px;
      color: var(--dim);
    }
    .jira-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      color: var(--link);
      background: none;
      padding: 0;
      font-weight: 500;
      font-size: 10.5px;
      cursor: pointer;
      transition: all 0.12s;
      text-decoration: none;
    }
    .jira-badge:hover { text-decoration: underline; }
    .jira-badge.disabled {
      cursor: help;
      opacity: 0.85;
    }
    .jira-badge .jira-icon { font-size: 10px; opacity: 0.85; }
    .created-on {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      opacity: 0.85;
    }

    /* --- TODOs --- */
    .todo-list { padding: 4px 0; }
    .todo-card {
      margin: 2px 6px;
      padding: 9px 10px;
      border-radius: var(--card-radius);
      cursor: pointer;
      border-left: 3px solid var(--border);
      transition: background 0.12s, border-color 0.12s;
      animation: fadeIn 0.2s ease-out both;
      position: relative;
    }
    .todo-card:hover,
    .todo-card:focus-visible { background: var(--hover-bg); }
    .todo-card:focus-visible { outline: 1px solid var(--focus); outline-offset: -1px; }
    .todo-card.status-open { border-left-color: var(--vscode-descriptionForeground); }
    .todo-card.status-in_progress { border-left-color: var(--vscode-terminal-ansiBlue); }
    .todo-card.status-done { border-left-color: var(--vscode-testing-iconPassed); }
    .todo-card.status-archived { border-left-color: var(--vscode-disabledForeground); opacity: 0.6; }
    .todo-card.status-done .todo-card-title { text-decoration: line-through; opacity: 0.7; }

    .todo-card-header {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .todo-card-title {
      flex: 1;
      font-size: 12.5px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      line-height: 1.3;
    }
    .todo-card-notes {
      font-size: 11px;
      color: var(--dim);
      margin-top: 4px;
      line-height: 1.4;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .todo-card-meta {
      font-size: 10.5px;
      color: var(--dim);
      margin-top: 5px;
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .todo-status-pill {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 10px;
      font-weight: 600;
      padding: 1px 7px;
      border-radius: 10px;
      border: 1px solid currentColor;
      background: color-mix(in srgb, currentColor 12%, transparent);
      flex-shrink: 0;
      white-space: nowrap;
      line-height: 1.4;
    }
    .todo-status-pill.status-open { color: var(--vscode-descriptionForeground); }
    .todo-status-pill.status-in_progress { color: var(--vscode-terminal-ansiBlue); }
    .todo-status-pill.status-done { color: var(--vscode-testing-iconPassed); }
    .todo-status-pill.status-archived { color: var(--vscode-disabledForeground); }

    .session-link-badge {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      font-size: 10px;
      color: var(--dim);
      flex-shrink: 0;
    }

    .todo-notes-editor {
      width: 100%;
      box-sizing: border-box;
      min-height: 100px;
      max-height: 320px;
      padding: 8px 10px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--fg);
      font-family: inherit;
      font-size: 12px;
      line-height: 1.5;
      resize: vertical;
    }
    .todo-notes-editor:focus { outline: 1px solid var(--focus); border-color: var(--focus); }

    .attached-session-row {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 8px;
      border-radius: 4px;
      background: var(--hover-bg);
      margin-bottom: 4px;
      font-size: 12px;
    }
    .attached-session-row .attached-title {
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .attached-session-row button {
      background: none;
      border: 1px solid var(--border);
      color: var(--dim);
      cursor: pointer;
      padding: 2px 7px;
      border-radius: 3px;
      font-size: 10px;
      font-family: inherit;
    }
    .attached-session-row button:hover { color: var(--fg); border-color: var(--fg); }
    .attached-session-row button.danger:hover { color: var(--error); border-color: var(--error); }

    /* Quick link (Webex / Slack / Zoom / GitHub PR / etc.) */
    .link-chip {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: color-mix(in srgb, var(--link) 14%, transparent);
      color: var(--link);
      border: 1px solid color-mix(in srgb, var(--link) 40%, transparent);
      border-radius: 10px;
      font-size: 10px;
      padding: 1px 6px;
      cursor: pointer;
      flex-shrink: 0;
      line-height: 1.4;
      font-family: inherit;
    }
    .link-chip:hover {
      background: color-mix(in srgb, var(--link) 26%, transparent);
    }
    .link-row {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 8px;
      border-radius: 4px;
      background: var(--hover-bg);
      font-size: 11.5px;
      margin-bottom: 4px;
    }
    .link-row:last-of-type { margin-bottom: 4px; }
    .link-icon { flex-shrink: 0; }
    .link-anchor {
      flex: 1;
      color: var(--link);
      text-decoration: none;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      cursor: pointer;
    }
    .link-anchor:hover { text-decoration: underline; }
    .link-action {
      background: none;
      border: 1px solid var(--border);
      color: var(--dim);
      cursor: pointer;
      padding: 1px 6px;
      border-radius: 3px;
      font-size: 10px;
      font-family: inherit;
      flex-shrink: 0;
    }
    .link-action:hover { color: var(--fg); border-color: var(--fg); }
    .link-action[data-act="remove"]:hover { color: var(--error); border-color: var(--error); }

    /* Linked-TODO indicator on session cards */
    .session-todo-badge {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 8px;
      background: color-mix(in srgb, var(--link) 14%, transparent);
      color: var(--link);
      flex-shrink: 0;
      line-height: 1.4;
    }

    /* --- Detail panel --- */
    .detail-panel { display: none; padding: 0; overflow-y: auto; }
    .detail-panel.active { display: block; animation: fadeIn 0.2s ease-out; }

    .detail-header {
      position: sticky;
      top: 0;
      background: var(--bg);
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      z-index: 5;
    }
    .detail-back {
      font-size: 12px;
      color: var(--link);
      cursor: pointer;
      background: none;
      border: none;
      display: flex;
      align-items: center;
      gap: 4px;
      margin-bottom: 12px;
      font-family: inherit;
      font-weight: 500;
      padding: 4px 0;
    }
    .detail-back:hover { text-decoration: underline; }
    .detail-title-row { display: flex; align-items: center; gap: 8px; }
    .detail-title {
      font-size: 14px;
      font-weight: 600;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .detail-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding: 10px 12px;
    }
    .detail-actions .act-btn {
      flex: 0 0 auto;
      max-width: 100%;
      min-height: 28px;
      padding: 6px 10px;
      text-align: center;
      overflow: visible;
    }

    .detail-body { padding: 0 12px 16px; }

    .detail-section { margin-bottom: 14px; }
    .detail-section h4 {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      color: var(--dim);
      margin-bottom: 6px;
    }

    .metrics-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4px;
    }
    .metric-cell {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      color: var(--dim);
      padding: 3px 0;
    }
    .metric-val { color: var(--fg); font-weight: 500; }

    .file-item {
      font-size: 11px;
      color: var(--dim);
      padding: 2px 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-family: var(--vscode-editor-font-family, monospace);
    }

    .related-item {
      padding: 6px 8px;
      cursor: pointer;
      border-radius: 4px;
      font-size: 12px;
      transition: background 0.1s;
    }
    .related-item:hover { background: var(--hover-bg); }

    /* --- Conversation preview --- */
    .convo-preview { display: flex; flex-direction: column; gap: 8px; }
    .msg-bubble {
      padding: 8px 10px;
      border-radius: 8px;
      font-size: 11.5px;
      line-height: 1.5;
      max-height: 120px;
      overflow: hidden;
      position: relative;
      word-break: break-word;
      max-width: 90%;
    }
    .msg-bubble::after {
      content: '';
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      height: 30px;
      background: linear-gradient(transparent, var(--bg));
      pointer-events: none;
    }
    .msg-bubble.user {
      background: rgba(128,128,128,0.08);
      border-left: 2px solid var(--link);
      align-self: flex-end;
      border-radius: 8px 8px 0 8px;
    }
    .msg-bubble.assistant {
      background: rgba(78,201,176,0.06);
      border-left: 2px solid var(--success);
      align-self: flex-start;
      border-radius: 8px 8px 8px 0;
    }
    .msg-label {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      margin-bottom: 3px;
      color: var(--dim);
    }
    .msg-text { white-space: pre-wrap; }
    .convo-more {
      text-align: center;
      font-size: 11px;
      color: var(--dim);
      padding: 4px;
    }
  </style>
</head>
<body>
  <div class="tab-bar" role="tablist">
    <button class="tab-btn active" id="tabSessions" role="tab" aria-selected="true" data-tab="sessions">Sessions</button>
    <button class="tab-btn" id="tabTodos" role="tab" aria-selected="false" data-tab="todos">
      TODOs <span class="tab-count" id="todoTabCount">0</span>
    </button>
  </div>

  <div id="sessionsPanel" class="panel active">
  <div class="toolbar">
    <div class="toolbar-row">
      <div class="search-wrap">
        <span class="search-icon">&#x1F50D;</span>
        <input class="search-input" id="searchInput" type="text" placeholder="Search sessions..." aria-label="Search sessions" />
        <div class="scope-seg" role="group" aria-label="Search scope">
          <button class="scope-seg-btn" id="scopeTitleBtn" type="button" aria-pressed="false" title="Match only session names, tags, notes, branches, and JIRA keys">Title</button>
          <button class="scope-seg-btn active" id="scopeAllBtn" type="button" aria-pressed="true" title="Also match inside chat message content">+ Chat</button>
        </div>
      </div>
    </div>
    <div class="toolbar-row" style="justify-content: space-between;">
      <div style="display: flex; gap: 4px;">
        <button class="toggle-btn" id="wsToggle" title="Show only sessions from the current workspace">&#x1F4C1; Workspace</button>
        <button class="toggle-btn" id="selectToggle" title="Select multiple sessions to delete">&#x2611; Select</button>
      </div>
      <div style="display: flex; gap: 4px;">
        <select class="sort-select" id="sortSelect" title="Sort by">
          <option value="lastMessageAt">Recent</option>
          <option value="createdAt">Created</option>
          <option value="displayName">Name</option>
          <option value="messageCount">Messages</option>
        </select>
        <button class="icon-btn" id="viewToggleBtn" title="Toggle Minimal/Detailed View">&#x2261;</button>
        <button class="icon-btn" id="refreshBtn" title="Refresh">&#x21BB;</button>
      </div>
    </div>
    <div class="select-bar" id="selectBar">
      <span class="select-count" id="selectCount">0 selected</span>
      <span class="spacer"></span>
      <button id="selectAllBtn" title="Select all visible sessions">Select all</button>
      <button id="deleteSelectedBtn" class="primary-danger" disabled>Delete</button>
      <button id="cancelSelectBtn" title="Exit selection mode">Cancel</button>
    </div>
    <div class="tag-bar" id="tagBar"></div>
    <div class="filter-banner" id="filterBanner">
      <span>Filtered by:</span>
      <strong id="filterName"></strong>
      <button class="filter-clear" id="clearFilter">Clear</button>
    </div>
  </div>

  <div id="listView">
    <div class="loading-state" id="loadingState">
      <div class="skeleton"></div>
      <div class="skeleton" style="animation-delay:.15s"></div>
      <div class="skeleton" style="animation-delay:.3s"></div>
      <div class="skeleton" style="animation-delay:.45s"></div>
    </div>
    <div class="session-list" id="sessionList" role="list" aria-label="Chat sessions"></div>
    <div class="restore-banner" id="restoreBanner" style="display:none">
      <span id="restoreText"></span>
      <button class="restore-btn" id="restoreBtn">Restore All</button>
    </div>
    <div id="counterRow" class="counter-row" style="justify-content: center; padding: 12px 0; border-top: 1px solid var(--border); margin-top: 8px;"></div>
  </div>

  <div id="detailView" class="detail-panel">
    <div class="detail-header">
      <button class="detail-back" id="backBtn">&#x2190; Back</button>
      <div class="detail-title-row">
        <div class="detail-title" id="detailTitle"></div>
      </div>
    </div>
    <div class="detail-actions" id="detailActions"></div>
    <div class="detail-body" id="detailBody"></div>
  </div>
  </div>

  <div id="todosPanel" class="panel">
    <div class="toolbar">
      <div class="toolbar-row">
        <div class="search-wrap">
          <span class="search-icon">&#x1F50D;</span>
          <input class="search-input" id="todoSearchInput" type="text" placeholder="Search TODOs..." aria-label="Search TODOs" />
        </div>
      </div>
      <div class="toolbar-row" style="justify-content: space-between;">
        <div style="display: flex; gap: 4px;">
          <select class="sort-select" id="todoStatusFilter" title="Filter by status">
            <option value="active">Active</option>
            <option value="all">All</option>
            <option value="open">Open</option>
            <option value="in_progress">In Progress</option>
            <option value="done">Done</option>
            <option value="archived">Archived</option>
          </select>
        </div>
        <div style="display: flex; gap: 4px;">
          <button class="toggle-btn" id="newTodoBtn" title="Create a new TODO">+ New TODO</button>
        </div>
      </div>
    </div>

    <div id="todoListView">
      <div class="todo-list" id="todoList" role="list" aria-label="TODOs"></div>
      <div id="todoCounterRow" class="counter-row" style="justify-content: center; padding: 12px 0; border-top: 1px solid var(--border); margin-top: 8px;"></div>
    </div>

    <div id="todoDetailView" class="detail-panel">
      <div class="detail-header">
        <button class="detail-back" id="todoBackBtn">&#x2190; Back</button>
        <div class="detail-title-row">
          <div class="detail-title" id="todoDetailTitle"></div>
        </div>
      </div>
      <div class="detail-actions" id="todoDetailActions"></div>
      <div class="detail-body" id="todoDetailBody"></div>
    </div>
  </div>

  <script nonce="${nonce}">
    try {
    const vscode = acquireVsCodeApi();
    let allSessions = [];
    let activeFilter = null;
    let currentSort = 'lastMessageAt';
    let jiraBaseUrl = '';
    let selectMode = false;
    let activeSessionId = null;
    const selectedIds = new Set();

    // TODO state
    let allTodos = [];
    let todoCountBySession = {};
    let todoStatusFilter = 'active';
    let todoSearchQuery = '';
    let openTodoId = null;
    let activeTab = 'sessions';

    const STATUS_LABELS = {
      none:'', todo:'TODO', in_progress:'In Progress', pr_created:'PR Created',
      in_review:'In Code Review', changes_requested:'Changes Requested',
      approved:'Approved', merged:'Merged', done:'Done', abandoned:'Abandoned'
    };
    const STATUS_SHORT_LABELS = {
      none:'', todo:'TODO', in_progress:'WIP', pr_created:'PR',
      in_review:'Review', changes_requested:'Changes',
      approved:'Approved', merged:'Merged', done:'Done', abandoned:'Closed'
    };
    const STATUS_COLORS = {
      none:'', 
      todo:'var(--vscode-descriptionForeground)', 
      in_progress:'var(--vscode-terminal-ansiBlue)', 
      pr_created:'var(--vscode-problemsWarningIcon-foreground)',
      in_review:'var(--vscode-terminal-ansiMagenta)', 
      changes_requested:'var(--vscode-errorForeground)',
      approved:'var(--vscode-testing-iconPassed)', 
      merged:'var(--vscode-testing-iconPassed)', 
      done:'var(--vscode-testing-iconPassed)', 
      abandoned:'var(--vscode-disabledForeground)'
    };

    const $ = id => document.getElementById(id);
    const searchInput = $('searchInput');
    const sortSelect = $('sortSelect');
    const refreshBtn = $('refreshBtn');
    const counterRow = $('counterRow');
    const tagBar = $('tagBar');
    const filterBanner = $('filterBanner');
    const filterName = $('filterName');
    const clearFilter = $('clearFilter');
    const sessionList = $('sessionList');
    const loadingState = $('loadingState');
    const listView = $('listView');
    const detailView = $('detailView');
    const backBtn = $('backBtn');
    const wsToggle = $('wsToggle');
    const restoreBanner = $('restoreBanner');
    const restoreText = $('restoreText');
    const restoreBtn = $('restoreBtn');
    const selectToggle = $('selectToggle');
    const selectBar = $('selectBar');
    const selectCount = $('selectCount');
    const selectAllBtn = $('selectAllBtn');
    const deleteSelectedBtn = $('deleteSelectedBtn');
    const cancelSelectBtn = $('cancelSelectBtn');
    const scopeTitleBtn = $('scopeTitleBtn');
    const scopeAllBtn = $('scopeAllBtn');
    const viewToggleBtn = $('viewToggleBtn');

    const tabSessions = $('tabSessions');
    const tabTodos = $('tabTodos');
    const sessionsPanel = $('sessionsPanel');
    const todosPanel = $('todosPanel');
    const todoTabCount = $('todoTabCount');
    const todoListEl = $('todoList');
    const todoListView = $('todoListView');
    const todoDetailView = $('todoDetailView');
    const todoDetailTitle = $('todoDetailTitle');
    const todoDetailActions = $('todoDetailActions');
    const todoDetailBody = $('todoDetailBody');
    const todoBackBtn = $('todoBackBtn');
    const todoSearchInput = $('todoSearchInput');
    const todoStatusFilterEl = $('todoStatusFilter');
    const newTodoBtn = $('newTodoBtn');
    const todoCounterRow = $('todoCounterRow');

    let wsOnly = false;

    const persisted = (typeof vscode.getState === 'function' ? vscode.getState() : null) || {};
    let searchScope = persisted.searchScope === 'title' ? 'title' : 'all';
    let minimalView = persisted.minimalView === true;
    
    applyScopeUI();
    applyViewUI();

    function applyScopeUI() {
      const titleOnly = searchScope === 'title';
      scopeTitleBtn.classList.toggle('active', titleOnly);
      scopeAllBtn.classList.toggle('active', !titleOnly);
      scopeTitleBtn.setAttribute('aria-pressed', String(titleOnly));
      scopeAllBtn.setAttribute('aria-pressed', String(!titleOnly));
    }

    function applyViewUI() {
      document.body.classList.toggle('minimal-mode', minimalView);
      if (viewToggleBtn) {
        viewToggleBtn.innerHTML = minimalView ? '&#x229F;' : '&#x2261;';
        viewToggleBtn.title = minimalView ? 'Switch to Detailed View' : 'Switch to Minimal View';
      }
    }

    function persistState() {
      if (typeof vscode.setState !== 'function') { return; }
      const prev = (typeof vscode.getState === 'function' ? vscode.getState() : null) || {};
      vscode.setState({ ...prev, searchScope, minimalView });
    }

    function setScope(next) {
      if (next !== 'title' && next !== 'all') { return; }
      if (next === searchScope) { return; }
      searchScope = next;
      applyScopeUI();
      persistState();
      if (searchInput.value.trim().length > 0) {
        vscode.postMessage({ type: 'search', query: searchInput.value, scope: searchScope });
      }
    }

    if (viewToggleBtn) {
      viewToggleBtn.addEventListener('click', () => {
        minimalView = !minimalView;
        applyViewUI();
        persistState();
      });
    }

    scopeTitleBtn.addEventListener('click', () => setScope('title'));
    scopeAllBtn.addEventListener('click', () => setScope('all'));

    restoreBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'restoreDeleted' });
    });

    selectToggle.addEventListener('click', () => {
      setSelectMode(!selectMode);
    });
    cancelSelectBtn.addEventListener('click', () => {
      setSelectMode(false);
    });
    selectAllBtn.addEventListener('click', () => {
      const anyUnselected = allSessions.some(s => !selectedIds.has(s.id));
      if (anyUnselected) {
        for (const s of allSessions) { selectedIds.add(s.id); }
      } else {
        selectedIds.clear();
      }
      renderSessions(allSessions);
      updateSelectBar();
    });
    deleteSelectedBtn.addEventListener('click', () => {
      if (selectedIds.size === 0) { return; }
      vscode.postMessage({ type: 'deleteSessions', sessionIds: [...selectedIds] });
      // The backend prompts for confirmation and clears selection mode on success via refresh.
      setSelectMode(false);
    });

    function setSelectMode(enabled) {
      selectMode = !!enabled;
      selectedIds.clear();
      document.body.classList.toggle('select-mode', selectMode);
      selectBar.classList.toggle('active', selectMode);
      selectToggle.classList.toggle('active', selectMode);
      renderSessions(allSessions);
      updateSelectBar();
    }

    function updateSelectBar() {
      const count = selectedIds.size;
      selectCount.textContent = count + ' selected';
      deleteSelectedBtn.disabled = count === 0;
      deleteSelectedBtn.textContent = count > 0 ? 'Delete ' + count : 'Delete';
    }

    wsToggle.addEventListener('click', () => {
      wsOnly = !wsOnly;
      wsToggle.classList.toggle('active', wsOnly);
      vscode.postMessage({ type: 'toggleWorkspaceFilter', enabled: wsOnly });
    });

    let searchTimeout = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        vscode.postMessage({ type: 'search', query: searchInput.value, scope: searchScope });
      }, 200);
    });

    sortSelect.addEventListener('change', () => {
      currentSort = sortSelect.value;
      renderSessions(allSessions);
    });

    refreshBtn.addEventListener('click', () => {
      refreshBtn.classList.add('spinning');
      vscode.postMessage({ type: 'refresh' });
    });

    clearFilter.addEventListener('click', () => {
      activeFilter = null;
      filterBanner.classList.remove('visible');
      vscode.postMessage({ type: 'refresh' });
    });

    backBtn.addEventListener('click', () => {
      detailView.classList.remove('active');
      listView.style.display = 'block';
      document.getElementById('sessionsPanel')?.classList.remove('in-detail');
    });

    // Safety net: if the extension host ever fails to respond after sending
    // the initial 'loading' (e.g., sql.js heap corrupted, stuck async, etc.)
    // we don't want the user staring at the skeleton forever with no idea
    // what's wrong. Show a recoverable error after a generous timeout.
    let loadingTimeoutId = null;
    const LOADING_TIMEOUT_MS = 30000;
    function clearLoadingTimeout() {
      if (loadingTimeoutId !== null) {
        clearTimeout(loadingTimeoutId);
        loadingTimeoutId = null;
      }
    }
    function scheduleLoadingTimeout() {
      clearLoadingTimeout();
      loadingTimeoutId = setTimeout(() => {
        loadingTimeoutId = null;
        if (loadingState.style.display === 'none') { return; }
        loadingState.style.display = 'none';
        refreshBtn.classList.remove('spinning');
        sessionList.innerHTML =
          '<div class="state-msg error">' +
            '<div class="state-icon">&#x26A0;</div>' +
            '<h3>Sessions taking too long to load</h3>' +
            '<p>The extension didn\\'t respond within 30s. ' +
            'Try clicking refresh, or run "Developer: Reload Window" if it persists.</p>' +
            '<button class="act-btn primary" id="loadingRetry" style="margin-top:10px;">Retry</button>' +
          '</div>';
        const retry = document.getElementById('loadingRetry');
        if (retry) {
          retry.addEventListener('click', () => {
            refreshBtn.classList.add('spinning');
            vscode.postMessage({ type: 'refresh' });
          });
        }
      }, LOADING_TIMEOUT_MS);
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;

      if (msg.type === 'loading') {
        loadingState.style.display = 'flex';
        scheduleLoadingTimeout();
      }

      if (msg.type === 'error') {
        clearLoadingTimeout();
        loadingState.style.display = 'none';
        refreshBtn.classList.remove('spinning');
        sessionList.innerHTML =
          '<div class="state-msg error">' +
            '<div class="state-icon">&#x26A0;</div>' +
            '<h3>Failed to load sessions</h3>' +
            '<p>' + escapeHtml(msg.message || 'Unknown error') + '</p>' +
          '</div>';
      }

      if (msg.type === 'activeSession') {
        activeSessionId = msg.sessionId || null;
        applyActiveHighlight();
      }

      if (msg.type === 'sessions') {
        clearLoadingTimeout();
        loadingState.style.display = 'none';
        refreshBtn.classList.remove('spinning');
        allSessions = msg.sessions || [];
        if (typeof msg.jiraBaseUrl === 'string') {
          jiraBaseUrl = msg.jiraBaseUrl;
        }
        if (msg.activeSessionId !== undefined) {
          activeSessionId = msg.activeSessionId || null;
        }
        if (msg.todoCountBySession) {
          todoCountBySession = msg.todoCountBySession;
        }
        // Drop stale selection ids that were just deleted / hidden.
        const visibleIds = new Set(allSessions.map(s => s.id));
        for (const id of [...selectedIds]) {
          if (!visibleIds.has(id)) { selectedIds.delete(id); }
        }
        renderTags(msg.tags || []);
        renderCounter(allSessions);
        renderSessions(allSessions);
        updateSelectBar();
        if (msg.workspaceOnly !== undefined) {
          wsOnly = msg.workspaceOnly;
          wsToggle.classList.toggle('active', wsOnly);
        }
        if (msg.hasWorkspace === false) {
          wsToggle.style.display = 'none';
        } else {
          wsToggle.style.display = '';
        }
        if (msg.activeFilter) {
          activeFilter = msg.activeFilter;
          filterBanner.classList.add('visible');
          filterName.textContent = msg.activeFilter;
        }
        renderRestoreBanner(msg.hiddenCount || 0);
      }

      if (msg.type === 'sessionDetail') {
        showDetail(msg.session, msg.related || []);
      }

      if (msg.type === 'sessionPatch') {
        applySessionPatch(msg.session, msg.todoCountBySession);
        if (Array.isArray(msg.tags)) { renderTags(msg.tags); }
      }

      if (msg.type === 'sessionRemove') {
        applySessionRemove(msg.sessionId, msg.hiddenCount);
        if (Array.isArray(msg.tags)) { renderTags(msg.tags); }
      }

      if (msg.type === 'todos') {
        allTodos = Array.isArray(msg.todos) ? msg.todos : [];
        updateTodoTabCount();
        renderTodoList();
        // If we're viewing a TODO that just got updated, re-render its detail.
        if (openTodoId) {
          const fresh = allTodos.find(t => t.id === openTodoId);
          if (fresh) { showTodoDetail(fresh); }
          else {
            openTodoId = null;
            todoDetailView.classList.remove('active');
            todoListView.style.display = 'block';
            document.getElementById('todosPanel')?.classList.remove('in-detail');
          }
        }
      }
    });

    function renderCounter(sessions) {
      const total = sessions.length;
      const pinned = sessions.filter(s => s.pinned).length;
      const totalMsgs = sessions.reduce((sum, s) => sum + (s.metrics?.messageCount || 0), 0);
      let html = '<span>' + total + ' session' + (total !== 1 ? 's' : '') + '</span>';
      if (pinned > 0) html += '<span>&#x1F4CC; ' + pinned + ' pinned</span>';
      html += '<span>' + totalMsgs + ' messages</span>';
      counterRow.innerHTML = html;
    }

    function renderRestoreBanner(count) {
      if (count > 0) {
        restoreText.textContent = count + ' deleted session' + (count !== 1 ? 's' : '');
        restoreBanner.style.display = '';
      } else {
        restoreBanner.style.display = 'none';
      }
    }

    function renderTags(tags) {
      tagBar.innerHTML = '';
      for (const tag of tags.slice(0, 20)) {
        const chip = document.createElement('button');
        chip.className = 'tag-chip' + (activeFilter === tag ? ' active' : '');
        chip.textContent = tag;
        chip.addEventListener('click', () => {
          activeFilter = tag;
          filterBanner.classList.add('visible');
          filterName.textContent = tag;
          vscode.postMessage({ type: 'filterByTag', tag });
        });
        tagBar.appendChild(chip);
      }
    }

    function sortSessions(sessions) {
      const sorted = [...sessions];
      const pinned = sorted.filter(s => s.pinned);
      const rest = sorted.filter(s => !s.pinned);

      rest.sort((a, b) => {
        switch (currentSort) {
          case 'createdAt': return b.createdAt - a.createdAt;
          case 'displayName': return (a.displayName || '').localeCompare(b.displayName || '');
          case 'messageCount': return (b.metrics?.messageCount || 0) - (a.metrics?.messageCount || 0);
          default: return b.lastMessageAt - a.lastMessageAt;
        }
      });
      return [...pinned, ...rest];
    }

    function applyActiveHighlight() {
      const cards = sessionList.querySelectorAll('.session-card');
      cards.forEach(card => {
        const id = card.getAttribute('data-session-id');
        const isActive = !!activeSessionId && id === activeSessionId;
        card.classList.toggle('active', isActive);
      });
    }

    /**
     * In-place patch: swap one card's DOM without touching the rest of the
     * list, preserving scroll position and any other transient UI state.
     * Falls back to a full re-render when the change affects sort order
     * (currently: pin toggle) or when the card isn't in the DOM yet.
     */
    function applySessionPatch(updated, todoCounts) {
      if (!updated || !updated.id) { return; }
      if (todoCounts && typeof todoCounts === 'object') {
        todoCountBySession = todoCounts;
      }
      const idx = allSessions.findIndex(s => s.id === updated.id);
      if (idx === -1) {
        // Not in our visible list (e.g. filtered out, or just unhid): defer
        // to a full refresh so positioning stays correct.
        vscode.postMessage({ type: 'refresh' });
        return;
      }
      const prev = allSessions[idx];
      allSessions[idx] = updated;

      const reorderRequired = prev.pinned !== updated.pinned;
      if (reorderRequired) {
        renderSessions(allSessions);
        renderCounter(allSessions);
        return;
      }

      const card = sessionList.querySelector(
        '.session-card[data-session-id="' + cssEscape(updated.id) + '"]',
      );
      if (!card) {
        renderSessions(allSessions);
        renderCounter(allSessions);
        return;
      }
      const fresh = createSessionCard(updated);
      // Suppress the entrance animation so the card doesn't flash on patch.
      fresh.style.animation = 'none';
      card.replaceWith(fresh);
      renderCounter(allSessions);
    }

    function applySessionRemove(sessionId, hiddenCount) {
      if (!sessionId) { return; }
      const idx = allSessions.findIndex(s => s.id === sessionId);
      if (idx !== -1) { allSessions.splice(idx, 1); }
      selectedIds.delete(sessionId);
      const card = sessionList.querySelector(
        '.session-card[data-session-id="' + cssEscape(sessionId) + '"]',
      );
      if (card) { card.remove(); }
      renderCounter(allSessions);
      updateSelectBar();
      if (typeof hiddenCount === 'number') {
        renderRestoreBanner(hiddenCount);
      }
      if (allSessions.length === 0) {
        renderSessions(allSessions);
      }
    }

    function renderSessions(sessions) {
      const sorted = sortSessions(sessions);
      sessionList.innerHTML = '';

      if (sorted.length === 0) {
        const isSearching = searchInput.value.trim().length > 0 || activeFilter;
        sessionList.innerHTML =
          '<div class="state-msg">' +
            '<div class="state-icon">' + (isSearching ? '&#x1F50D;' : '&#x1F4ED;') + '</div>' +
            '<h3>' + (isSearching ? 'No matching sessions' : 'No sessions found') + '</h3>' +
            '<p>' + (isSearching ? 'Try a different search term or clear the filter.' : 'Sessions from your Cursor agent chats will appear here.') + '</p>' +
          '</div>';
        return;
      }

      if (currentSort === 'displayName' || currentSort === 'messageCount') {
        for (let i = 0; i < sorted.length; i++) {
          const el = createSessionCard(sorted[i]);
          el.style.animationDelay = Math.min(i * 30, 300) + 'ms';
          sessionList.appendChild(el);
        }
        return;
      }

      const groups = groupByTime(sorted);
      let idx = 0;
      for (const [label, items] of groups) {
        const lbl = document.createElement('div');
        lbl.className = 'time-group-label';
        lbl.innerHTML = label + ' <span class="group-count">(' + items.length + ')</span>';
        sessionList.appendChild(lbl);

        for (const s of items) {
          const el = createSessionCard(s);
          el.style.animationDelay = Math.min(idx * 30, 400) + 'ms';
          sessionList.appendChild(el);
          idx++;
        }
      }
    }

    function createSessionCard(session) {
      const el = document.createElement('div');
      const isSelected = selectedIds.has(session.id);
      const isActive = activeSessionId && session.id === activeSessionId;
      el.className = 'session-card' +
        (session.pinned ? ' pinned' : '') +
        (selectMode ? ' selectable' : '') +
        (isSelected ? ' selected' : '') +
        (isActive ? ' active' : '');
      el.setAttribute('tabindex', '0');
      el.setAttribute('role', 'listitem');
      el.setAttribute('aria-label', session.displayName || 'Session');
      el.setAttribute('data-session-id', session.id);
      if (selectMode) { el.setAttribute('aria-pressed', String(isSelected)); }

      const safeId = escapeHtml(session.id);
      const pinSymbol = session.pinned ? '&#x1F4CC;' : '&#x25CB;';
      const mode = session.metrics?.mode || '';

      let metaParts = [];
      metaParts.push(formatRelativeTime(session.lastMessageAt));
      if (session.metrics?.messageCount > 0) {
        metaParts.push(session.metrics.messageCount + ' msgs');
      }
      if (session.metrics?.codeBlockCount > 0) {
        metaParts.push(session.metrics.codeBlockCount + ' code');
      }
      if (session.metrics?.linesAdded > 0 || session.metrics?.linesRemoved > 0) {
        metaParts.push('+' + (session.metrics.linesAdded || 0) + '/-' + (session.metrics.linesRemoved || 0));
      }
      if (session.metrics?.filesChangedCount > 0) {
        metaParts.push(session.metrics.filesChangedCount + ' files');
      }

      const subtitle = session.autoTitle !== session.displayName ? session.autoTitle : '';

      const status = session.status || 'none';
      const statusLabel = STATUS_LABELS[status] || '';
      const statusShort = STATUS_SHORT_LABELS[status] || statusLabel;
      const statusColor = STATUS_COLORS[status] || '';

      const createdText = session.createdAt ? formatAbsoluteDate(session.createdAt) : '';
      const jiraBadgeHtml = buildJiraBadge(session.jiraTicket);

      const todoCount = todoCountBySession[session.id] || 0;
      const todoBadgeHtml = todoCount > 0
        ? '<span class="session-todo-badge" title="Linked to ' + todoCount + ' TODO' + (todoCount !== 1 ? 's' : '') + '">&#x1F4CB; ' + todoCount + '</span>'
        : '';

      el.innerHTML =
        '<span class="session-checkbox" aria-hidden="true">' + (isSelected ? '&#x2713;' : '') + '</span>' +
        '<div class="card-header">' +
          '<span class="card-title">' + escapeHtml(session.displayName) + '</span>' +
          todoBadgeHtml +
          (statusLabel
            ? '<button class="status-badge" data-action="setStatus" data-id="' + safeId
              + '" title="' + escapeHtml(statusLabel)
              + '" style="color:' + statusColor + ';">'
              + '<span class="status-dot"></span>'
              + escapeHtml(statusShort)
              + '</button>'
            : '') +
          '<span class="pin-toggle" data-action="pin" data-id="' + safeId + '">' + pinSymbol + '</span>' +
        '</div>' +
        (subtitle ? '<div class="card-subtitle">' + escapeHtml(subtitle) + '</div>' : '') +
        '<div class="card-meta">' +
          (mode ? '<span class="mode-badge ' + escapeHtml(mode) + '">' + escapeHtml(mode) + '</span><span class="meta-dot">&#183;</span>' : '') +
          (jiraBadgeHtml ? jiraBadgeHtml + '<span class="meta-dot">&#183;</span>' : '') +
          metaParts.map((p, i) =>
            (i > 0 ? '<span class="meta-dot">&#183;</span>' : '') +
            '<span class="meta-item">' + escapeHtml(p) + '</span>'
          ).join('') +
        '</div>' +
        (session.branches && session.branches.length > 0 ?
          '<div class="card-branches">' +
            session.branches.map(b =>
              '<span class="branch-chip">&#x2387; ' + escapeHtml(b) +
                '<button class="branch-remove" data-action="removeBranch" data-id="' + safeId + '" data-branch="' + escapeHtml(b) + '" title="Remove branch">&#x2715;</button>' +
              '</span>'
            ).join('') +
          '</div>' : '') +
        (session.tags.length > 0 ?
          '<div class="card-tags">' +
            session.tags.map(t =>
              '<span class="tag-chip" data-action="filterTag" data-tag="' + escapeHtml(t) + '">' +
                escapeHtml(t) +
                '<button class="tag-remove" data-action="removeTag" data-id="' + safeId + '" data-tag="' + escapeHtml(t) + '" title="Remove tag">&#x2715;</button>' +
              '</span>'
            ).join('') +
          '</div>' : '') +
        '<div class="card-actions">' +
          '<button class="act-btn primary" data-action="openSession" data-id="' + safeId + '">Open</button>' +
          '<button class="act-btn" data-action="previewSession" data-id="' + safeId + '">Preview</button>' +
          '<button class="act-btn" data-action="viewSession" data-id="' + safeId + '">Info</button>' +
          '<button class="act-btn" data-action="rename" data-id="' + safeId + '">Rename</button>' +
          '<button class="act-btn" data-action="tag" data-id="' + safeId + '">Tag</button>' +
          '<button class="act-btn" data-action="addBranch" data-id="' + safeId + '">Branch</button>' +
          '<button class="act-btn" data-action="setStatus" data-id="' + safeId + '">Status</button>' +
          '<button class="act-btn" data-action="setJiraTicket" data-id="' + safeId + '">' + (session.jiraTicket ? 'JIRA: ' + escapeHtml(session.jiraTicket) : 'JIRA') + '</button>' +
          '<button class="act-btn" data-action="export" data-id="' + safeId + '">Export</button>' +
          '<button class="act-btn danger" data-action="deleteSession" data-id="' + safeId + '">Delete</button>' +
        '</div>';

      function handleCardAction(rawTarget) {
        // Walk up to the nearest element that declares an action so clicks on
        // nested icons/labels (e.g. the emoji inside a JIRA badge) still route
        // to the right handler.
        const target = rawTarget?.closest?.('[data-action]') || rawTarget;
        const action = target?.dataset?.action;
        const id = target?.dataset?.id || session.id;

        if (action === 'pin') {
          vscode.postMessage({ type: 'pin', sessionId: id, pinned: !session.pinned });
        } else if (action === 'openSession') {
          vscode.postMessage({ type: 'openSession', sessionId: id });
        } else if (action === 'previewSession') {
          vscode.postMessage({ type: 'previewSession', sessionId: id });
        } else if (action === 'viewSession') {
          vscode.postMessage({ type: 'viewSession', sessionId: id });
        } else if (action === 'rename') {
          vscode.postMessage({ type: 'rename', sessionId: id });
        } else if (action === 'tag') {
          vscode.postMessage({ type: 'tag', sessionId: id });
        } else if (action === 'link') {
          vscode.postMessage({ type: 'link', sessionId: id });
        } else if (action === 'removeTag') {
          const tag = target.dataset?.tag;
          if (tag) { vscode.postMessage({ type: 'removeTag', sessionId: id, tag }); }
        } else if (action === 'setStatus') {
          vscode.postMessage({ type: 'setStatus', sessionId: id });
        } else if (action === 'addBranch') {
          vscode.postMessage({ type: 'addBranch', sessionId: id });
        } else if (action === 'removeBranch') {
          const branch = target.dataset?.branch;
          if (branch) { vscode.postMessage({ type: 'removeBranch', sessionId: id, branch }); }
        } else if (action === 'export') {
          vscode.postMessage({ type: 'export', sessionId: id, format: 'markdown' });
        } else if (action === 'deleteSession') {
          vscode.postMessage({ type: 'deleteSession', sessionId: id });
        } else if (action === 'openJira') {
          const ticket = target.dataset?.ticket;
          if (ticket) { vscode.postMessage({ type: 'openJira', ticket }); }
        } else if (action === 'openJiraSettings') {
          vscode.postMessage({ type: 'openJiraSettings' });
        } else if (action === 'setJiraTicket') {
          vscode.postMessage({ type: 'setJiraTicket', sessionId: id });
        } else if (action === 'filterTag') {
          const tag = target.dataset?.tag;
          if (tag) {
            activeFilter = tag;
            filterBanner.classList.add('visible');
            filterName.textContent = tag;
            vscode.postMessage({ type: 'filterByTag', tag });
          }
        } else {
          vscode.postMessage({ type: 'openSession', sessionId: session.id });
        }
      }

      el.addEventListener('click', (e) => {
        if (selectMode) {
          e.preventDefault();
          e.stopPropagation();
          toggleSelection(session.id);
          return;
        }
        handleCardAction(e.target);
      });
      el.addEventListener('keydown', (e) => {
        if (selectMode && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          toggleSelection(session.id);
          return;
        }
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          vscode.postMessage({ type: 'openSession', sessionId: session.id });
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          const next = el.nextElementSibling;
          if (next && next.classList.contains('session-card')) next.focus();
          else if (next?.nextElementSibling?.classList.contains('session-card')) next.nextElementSibling.focus();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          const prev = el.previousElementSibling;
          if (prev && prev.classList.contains('session-card')) prev.focus();
          else if (prev?.previousElementSibling?.classList.contains('session-card')) prev.previousElementSibling.focus();
        }
      });

      return el;
    }

    function showDetail(session, related) {
      listView.style.display = 'none';
      detailView.classList.add('active');
      document.getElementById('sessionsPanel')?.classList.add('in-detail');

      $('detailTitle').textContent = session.displayName;

      const actionsEl = $('detailActions');
      actionsEl.innerHTML =
        '<button class="act-btn primary" id="dOpen">Open in Chat</button>' +
        '<button class="act-btn" id="dPreview">Preview</button>' +
        '<button class="act-btn" id="dAttachTodo">+ TODO</button>' +
        '<button class="act-btn" id="dExportMd">MD</button>' +
        '<button class="act-btn" id="dExportJson">JSON</button>';

      $('dOpen')?.addEventListener('click', () => vscode.postMessage({ type: 'openSession', sessionId: session.id }));
      $('dPreview')?.addEventListener('click', () => vscode.postMessage({ type: 'previewSession', sessionId: session.id }));
      $('dAttachTodo')?.addEventListener('click', () => vscode.postMessage({ type: 'attachSessionToTodo', sessionId: session.id }));
      $('dExportMd')?.addEventListener('click', () => vscode.postMessage({ type: 'export', sessionId: session.id, format: 'markdown' }));
      $('dExportJson')?.addEventListener('click', () => vscode.postMessage({ type: 'export', sessionId: session.id, format: 'json' }));

      backBtn.focus();

      let html = '';

      html += '<div class="detail-section"><h4>Metrics</h4><div class="metrics-grid">';
      html += metricCell('Messages', session.metrics.messageCount);
      html += metricCell('Code blocks', session.metrics.codeBlockCount);
      html += metricCell('User msgs', session.metrics.userMessageCount);
      html += metricCell('AI msgs', session.metrics.assistantMessageCount);
      if (session.metrics.linesAdded !== undefined) {
        html += metricCell('Lines', '+' + session.metrics.linesAdded + ' / -' + (session.metrics.linesRemoved || 0));
      }
      if (session.metrics.filesChangedCount) {
        html += metricCell('Files changed', session.metrics.filesChangedCount);
      }
      html += '</div></div>';

      if (session.branches && session.branches.length > 0) {
        html += '<div class="detail-section"><h4>Branches</h4><div class="card-branches">' +
          session.branches.map(b =>
            '<span class="branch-chip">&#x2387; ' + escapeHtml(b) +
              '<button class="branch-remove" data-action="removeBranch" data-id="' + escapeHtml(session.id) + '" data-branch="' + escapeHtml(b) + '" title="Remove branch">&#x2715;</button>' +
            '</span>'
          ).join('') +
          '<button class="act-btn" id="dAddBranch" style="font-size:10px;padding:1px 6px;">+ Add</button>' +
          '</div></div>';
      } else {
        html += '<div class="detail-section"><h4>Branches</h4>' +
          '<button class="act-btn" id="dAddBranch" style="font-size:10px;padding:2px 8px;">+ Add Branch</button>' +
          '</div>';
      }

      const dStatus = session.status || 'none';
      const dStatusLabel = STATUS_LABELS[dStatus] || '';
      const dStatusColor = STATUS_COLORS[dStatus] || '';
      html += '<div class="detail-section"><h4>Status</h4>' +
        '<button class="status-badge" id="dSetStatus" style="' +
          (dStatusLabel ? 'background:color-mix(in srgb, ' + dStatusColor + ' 15%, transparent);color:' + dStatusColor + ';' : 'background:rgba(128,128,128,0.1);color:var(--dim);') +
        '">' +
          (dStatusLabel ? '<span class="status-dot" style="background:' + dStatusColor + ';"></span>' + escapeHtml(dStatusLabel) : 'Set status...') +
        '</button></div>';

      const linkedTodos = allTodos.filter(t => (t.sessionIds || []).includes(session.id));
      if (linkedTodos.length > 0) {
        html += '<div class="detail-section"><h4>Linked TODOs (' + linkedTodos.length + ')</h4>' +
          linkedTodos.map(t =>
            '<div class="attached-session-row" data-tid="' + escapeHtml(t.id) + '">' +
              '<span class="attached-title" title="' + escapeHtml(t.title) + '">' + escapeHtml(t.title) + '</span>' +
              '<span class="todo-status-pill status-' + t.status + '" style="margin:0 4px;"><span class="status-dot"></span>' + escapeHtml(TODO_STATUS_LABELS[t.status] || t.status) + '</span>' +
              '<button data-act="opentodo">Open</button>' +
            '</div>'
          ).join('') +
          '</div>';
      }

      const createdText = session.createdAt ? formatAbsoluteDate(session.createdAt) : '';
      const lastActiveText = session.lastMessageAt ? formatAbsoluteDate(session.lastMessageAt) : '';
      if (createdText || lastActiveText) {
        html += '<div class="detail-section"><h4>Timeline</h4><div class="card-info">' +
          (createdText ? '<span class="created-on">&#x1F4C5; Created ' + escapeHtml(createdText) + '</span>' : '') +
          (lastActiveText ? '<span class="created-on">&#x1F550; Last active ' + escapeHtml(lastActiveText) + '</span>' : '') +
          '</div></div>';
      }

      html += '<div class="detail-section"><h4>JIRA</h4><div class="card-info">' +
        (session.jiraTicket
          ? buildJiraBadge(session.jiraTicket) +
            ' <button class="act-btn" id="dSetJira" style="font-size:10px;padding:2px 8px;">Change</button>' +
            ' <button class="act-btn" id="dClearJira" style="font-size:10px;padding:2px 8px;">Clear</button>'
          : '<button class="act-btn" id="dSetJira" style="font-size:10px;padding:2px 8px;">+ Link ticket</button>') +
        '</div></div>';

      if (session.tags.length > 0) {
        html += '<div class="detail-section"><h4>Tags</h4><div class="card-tags">' +
          session.tags.map(t =>
            '<span class="tag-chip">' + escapeHtml(t) +
              '<button class="tag-remove" data-action="removeTag" data-id="' + escapeHtml(session.id) + '" data-tag="' + escapeHtml(t) + '" title="Remove tag">&#x2715;</button>' +
            '</span>'
          ).join('') +
          '</div></div>';
      }

      if (session.messages && session.messages.length > 0) {
        html += '<div class="detail-section"><h4>Conversation</h4><div class="convo-preview">';
        const preview = session.messages
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .slice(0, 6);
        for (const msg of preview) {
          const text = cleanContent(msg.content).slice(0, 500);
          html += '<div class="msg-bubble ' + msg.role + '">' +
            '<div class="msg-label">' + (msg.role === 'user' ? 'You' : 'Assistant') + '</div>' +
            '<div class="msg-text">' + escapeHtml(text) + '</div>' +
          '</div>';
        }
        if (session.messages.length > 6) {
          html += '<div class="convo-more">' + (session.messages.length - 6) + ' more messages...</div>';
        }
        html += '</div></div>';
      }

      if (session.metrics.filesTouched && session.metrics.filesTouched.length > 0) {
        html += '<div class="detail-section"><h4>Files Referenced</h4>' +
          session.metrics.filesTouched.slice(0, 15).map(f =>
            '<div class="file-item">' + escapeHtml(f) + '</div>'
          ).join('') +
          (session.metrics.filesTouched.length > 15 ? '<div class="convo-more">+' + (session.metrics.filesTouched.length - 15) + ' more</div>' : '') +
          '</div>';
      }

      if (related.length > 0) {
        html += '<div class="detail-section"><h4>Related Sessions</h4>' +
          related.map(r =>
            '<div class="related-item" data-id="' + escapeHtml(r.id) + '">' + escapeHtml(r.displayName) + '</div>'
          ).join('') +
          '</div>';
      }

      $('detailBody').innerHTML = html;

      $('dSetStatus')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'setStatus', sessionId: session.id });
      });

      $('dSetJira')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'setJiraTicket', sessionId: session.id });
      });
      $('dClearJira')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'clearJiraTicket', sessionId: session.id });
      });
      $('detailBody').querySelectorAll('.jira-badge').forEach(el => {
        el.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const action = el.dataset?.action;
          if (action === 'openJira') {
            const ticket = el.dataset?.ticket;
            if (ticket) { vscode.postMessage({ type: 'openJira', ticket }); }
          } else if (action === 'openJiraSettings') {
            vscode.postMessage({ type: 'openJiraSettings' });
          }
        });
      });

      $('detailBody').querySelectorAll('.tag-remove').forEach(el => {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          vscode.postMessage({ type: 'removeTag', sessionId: el.dataset.id, tag: el.dataset.tag });
        });
      });

      $('detailBody').querySelectorAll('.branch-remove').forEach(el => {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          vscode.postMessage({ type: 'removeBranch', sessionId: el.dataset.id, branch: el.dataset.branch });
        });
      });

      $('dAddBranch')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'addBranch', sessionId: session.id });
      });

      $('detailBody').querySelectorAll('.related-item').forEach(el => {
        el.addEventListener('click', () => {
          vscode.postMessage({ type: 'viewSession', sessionId: el.dataset.id });
        });
      });

      // Linked TODOs - click "Open" to switch to TODOs tab and show detail.
      $('detailBody').querySelectorAll('.attached-session-row[data-tid] button[data-act="opentodo"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const row = btn.closest('.attached-session-row');
          const tid = row?.getAttribute('data-tid');
          if (!tid) return;
          setActiveTab('todos');
          openTodoDetail(tid);
        });
      });
    }

    function metricCell(label, value) {
      const safe = value != null ? escapeHtml(String(value)) : '-';
      return '<div class="metric-cell"><span>' + escapeHtml(label) + ':</span> <span class="metric-val">' + safe + '</span></div>';
    }

    function cleanContent(str) {
      return (str || '')
        .replace(/<user_query>\\n?/g, '')
        .replace(/<\\/user_query>/g, '')
        .replace(/\\[Thinking\\].*$/gm, '')
        .replace(/\\[Tool call\\].*$/gm, '')
        .replace(/\\[Tool result\\].*$/gm, '')
        .trim();
    }

    function groupByTime(sessions) {
      const dayMs = 86400000;
      const todayStart = new Date().setHours(0,0,0,0);
      const yesterdayStart = todayStart - dayMs;
      const weekStart = todayStart - 7 * dayMs;
      const monthStart = todayStart - 30 * dayMs;

      const groups = new Map();
      groups.set('Pinned', []);
      groups.set('Today', []);
      groups.set('Yesterday', []);
      groups.set('This Week', []);
      groups.set('This Month', []);
      groups.set('Older', []);

      for (const s of sessions) {
        if (s.pinned) { groups.get('Pinned').push(s); continue; }
        const ts = s.lastMessageAt;
        if (!ts || ts >= todayStart) { groups.get('Today').push(s); }
        else if (ts >= yesterdayStart) { groups.get('Yesterday').push(s); }
        else if (ts >= weekStart) { groups.get('This Week').push(s); }
        else if (ts >= monthStart) { groups.get('This Month').push(s); }
        else { groups.get('Older').push(s); }
      }

      return [...groups.entries()].filter(([, items]) => items.length > 0);
    }

    function formatRelativeTime(ts) {
      const diff = Date.now() - ts;
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return 'just now';
      if (mins < 60) return mins + 'm ago';
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return hrs + 'h ago';
      const days = Math.floor(hrs / 24);
      if (days === 1) return 'yesterday';
      if (days < 7) return days + 'd ago';
      if (days < 30) return Math.floor(days / 7) + 'w ago';
      return new Date(ts).toLocaleDateString();
    }

    function formatAbsoluteDate(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      if (isNaN(d.getTime())) return '';
      const now = new Date();
      const sameYear = d.getFullYear() === now.getFullYear();
      const opts = sameYear
        ? { month: 'short', day: 'numeric' }
        : { month: 'short', day: 'numeric', year: 'numeric' };
      return d.toLocaleDateString(undefined, opts);
    }

    function toggleSelection(id) {
      if (selectedIds.has(id)) {
        selectedIds.delete(id);
      } else {
        selectedIds.add(id);
      }
      const card = sessionList.querySelector('[data-session-id="' + cssEscape(id) + '"]');
      if (card) {
        const selected = selectedIds.has(id);
        card.classList.toggle('selected', selected);
        card.setAttribute('aria-pressed', String(selected));
        const cb = card.querySelector('.session-checkbox');
        if (cb) { cb.innerHTML = selected ? '&#x2713;' : ''; }
      }
      updateSelectBar();
    }

    function cssEscape(value) {
      if (typeof CSS !== 'undefined' && CSS.escape) { return CSS.escape(value); }
      return String(value).replace(/[^a-zA-Z0-9_-]/g, ch => '\\\\' + ch);
    }

    function buildJiraBadge(ticket) {
      if (!ticket) return '';
      const safe = escapeHtml(ticket);
      if (jiraBaseUrl) {
        return '<a class="jira-badge" data-action="openJira" data-ticket="' + safe + '" title="Open ' + safe + ' in JIRA">' +
          '<span class="jira-icon">&#x1F517;</span>' + safe +
        '</a>';
      }
      return '<a class="jira-badge disabled" data-action="openJiraSettings" title="Click to set your JIRA base URL and enable ticket links">' +
        '<span class="jira-icon">&#x1F517;</span>' + safe +
      '</a>';
    }

    function escapeHtml(str) {
      if (!str) return '';
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    // ---------------------------------------------------------------------
    // Tabs
    // ---------------------------------------------------------------------
    function setActiveTab(tab) {
      activeTab = tab === 'todos' ? 'todos' : 'sessions';
      const isTodos = activeTab === 'todos';
      tabSessions.classList.toggle('active', !isTodos);
      tabTodos.classList.toggle('active', isTodos);
      tabSessions.setAttribute('aria-selected', String(!isTodos));
      tabTodos.setAttribute('aria-selected', String(isTodos));
      sessionsPanel.classList.toggle('active', !isTodos);
      todosPanel.classList.toggle('active', isTodos);
    }

    tabSessions.addEventListener('click', () => setActiveTab('sessions'));
    tabTodos.addEventListener('click', () => {
      setActiveTab('todos');
      // Ask backend for fresh todos when entering the tab.
      vscode.postMessage({ type: 'requestTodos' });
    });

    // ---------------------------------------------------------------------
    // TODOs
    // ---------------------------------------------------------------------
    const TODO_STATUS_LABELS = {
      open: 'Open',
      in_progress: 'In Progress',
      done: 'Done',
      archived: 'Archived',
    };

    function updateTodoTabCount() {
      const active = allTodos.filter(t => t.status !== 'archived' && t.status !== 'done').length;
      todoTabCount.textContent = String(active);
    }

    function getFilteredTodos() {
      const q = todoSearchQuery.trim().toLowerCase();
      return allTodos.filter(t => {
        if (todoStatusFilter === 'active') {
          if (t.status === 'archived' || t.status === 'done') return false;
        } else if (todoStatusFilter !== 'all') {
          if (t.status !== todoStatusFilter) return false;
        }
        if (!q) return true;
        const hay = (t.title + ' ' + (t.notes || '')).toLowerCase();
        return hay.includes(q);
      });
    }

    function renderTodoList() {
      const todos = getFilteredTodos();
      todoListEl.innerHTML = '';

      if (todos.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'state-msg';
        const isSearching = todoSearchQuery.trim().length > 0 || todoStatusFilter !== 'active';
        empty.innerHTML =
          '<div class="state-icon">' + (isSearching ? '&#x1F50D;' : '&#x1F4DD;') + '</div>' +
          '<h3>' + (isSearching ? 'No matching TODOs' : 'No TODOs yet') + '</h3>' +
          '<p>' + (isSearching
            ? 'Try a different filter or search term.'
            : 'Click "+ New TODO" to add one. You can attach sessions to track related work.') + '</p>';
        todoListEl.appendChild(empty);
        renderTodoCounter(todos);
        return;
      }

      const fragment = document.createDocumentFragment();
      for (const todo of todos) {
        fragment.appendChild(createTodoCard(todo));
      }
      todoListEl.appendChild(fragment);
      renderTodoCounter(todos);
    }

    function renderTodoCounter(todos) {
      if (!todoCounterRow) return;
      const total = todos.length;
      const open = todos.filter(t => t.status === 'open').length;
      const wip = todos.filter(t => t.status === 'in_progress').length;
      const done = todos.filter(t => t.status === 'done').length;
      let html = '<span>' + total + ' TODO' + (total !== 1 ? 's' : '') + '</span>';
      if (open > 0) html += '<span>' + open + ' open</span>';
      if (wip > 0) html += '<span>' + wip + ' WIP</span>';
      if (done > 0) html += '<span>' + done + ' done</span>';
      todoCounterRow.innerHTML = html;
    }

    function createTodoCard(todo) {
      const el = document.createElement('div');
      el.className = 'todo-card status-' + todo.status;
      el.setAttribute('tabindex', '0');
      el.setAttribute('role', 'listitem');
      el.setAttribute('data-todo-id', todo.id);

      const status = todo.status || 'open';
      const statusLabel = TODO_STATUS_LABELS[status] || status;
      const sessCount = (todo.attachedSessions || todo.sessionIds || []).length;
      const notes = todo.notes || '';
      const links = Array.isArray(todo.links) ? todo.links.filter(l => typeof l === 'string' && l.trim().length > 0) : [];
      const linkCount = links.length;
      const chipTitle = linkCount === 1 ? links[0] : (linkCount + ' link' + (linkCount !== 1 ? 's' : ''));
      const chipLabel = linkCount > 1 ? '&#x1F517; ' + linkCount : '&#x1F517;';

      el.innerHTML =
        '<div class="todo-card-header">' +
          '<span class="todo-card-title">' + escapeHtml(todo.title) + '</span>' +
          (linkCount > 0 ? '<button class="link-chip" data-action="openFirstLink" title="' + escapeHtml(chipTitle) + '">' + chipLabel + '</button>' : '') +
          '<span class="todo-status-pill status-' + status + '"><span class="status-dot"></span>' + escapeHtml(statusLabel) + '</span>' +
        '</div>' +
        (notes ? '<div class="todo-card-notes">' + escapeHtml(notes) + '</div>' : '') +
        '<div class="todo-card-meta">' +
          '<span>' + sessCount + ' session' + (sessCount !== 1 ? 's' : '') + '</span>' +
          '<span class="meta-dot">&#183;</span>' +
          '<span>' + escapeHtml(formatRelativeTime(todo.updatedAt)) + '</span>' +
        '</div>';

      const linkBtn = el.querySelector('.link-chip');
      if (linkBtn) {
        linkBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (linkCount === 1) {
            vscode.postMessage({ type: 'todoOpenLink', url: links[0] });
          } else {
            // Open the detail view so the user can pick a specific link.
            openTodoDetail(todo.id);
          }
        });
      }

      el.addEventListener('click', () => openTodoDetail(todo.id));
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openTodoDetail(todo.id);
        }
      });
      return el;
    }

    function openTodoDetail(todoId) {
      const todo = allTodos.find(t => t.id === todoId);
      if (!todo) return;
      openTodoId = todoId;
      showTodoDetail(todo);
    }

    function showTodoDetail(todo) {
      todoListView.style.display = 'none';
      todoDetailView.classList.add('active');
      document.getElementById('todosPanel')?.classList.add('in-detail');

      todoDetailTitle.textContent = todo.title;

      const status = todo.status || 'open';
      const statusLabel = TODO_STATUS_LABELS[status] || status;

      todoDetailActions.innerHTML =
        '<button class="act-btn primary" id="tEditTitle">Rename</button>' +
        '<button class="act-btn" id="tSetStatus">Status</button>' +
        '<button class="act-btn" id="tAttach">+ Session</button>' +
        '<button class="act-btn" id="tAddLink">+ Link</button>' +
        '<button class="act-btn danger" id="tDelete">Delete</button>';

      const attached = todo.attachedSessions || (todo.sessionIds || []).map(id => ({ id, title: '(unknown session)' }));
      let attachedHtml = '';
      if (attached.length === 0) {
        attachedHtml = '<div style="font-size:11px;color:var(--dim);">No sessions attached yet.</div>';
      } else {
        attachedHtml = attached.map(s =>
          '<div class="attached-session-row" data-sid="' + escapeHtml(s.id) + '">' +
            '<span class="attached-title" title="' + escapeHtml(s.title) + '">' + escapeHtml(s.title) + '</span>' +
            '<button data-act="open">Open</button>' +
            '<button data-act="view">View</button>' +
            '<button class="danger" data-act="detach" title="Detach from TODO">&#x2715;</button>' +
          '</div>'
        ).join('');
      }

      const safeNotes = escapeHtml(todo.notes || '');

      const todoLinks = Array.isArray(todo.links) ? todo.links : [];
      const linksHtml = todoLinks.length > 0
        ? todoLinks.map((url, i) =>
            '<div class="link-row" data-link-idx="' + i + '">' +
              '<span class="link-icon">&#x1F517;</span>' +
              '<a href="#" class="link-anchor" data-act="open" title="' + escapeHtml(url) + '">' + escapeHtml(url) + '</a>' +
              '<button class="link-action" data-act="edit" title="Edit">&#x270E;</button>' +
              '<button class="link-action" data-act="remove" title="Remove">&#x2715;</button>' +
            '</div>'
          ).join('') +
          '<button class="act-btn" id="tLinkAddInline" style="font-size:10px;padding:2px 8px;margin-top:4px;">+ Add Link</button>'
        : '<button class="act-btn" id="tLinkAddInline" style="font-size:10px;padding:2px 8px;">+ Add Link</button>';

      todoDetailBody.innerHTML =
        '<div class="detail-section">' +
          '<h4>Status</h4>' +
          '<span class="todo-status-pill status-' + status + '"><span class="status-dot"></span>' + escapeHtml(statusLabel) + '</span>' +
        '</div>' +
        '<div class="detail-section">' +
          '<h4>Links (' + todoLinks.length + ')</h4>' +
          linksHtml +
        '</div>' +
        '<div class="detail-section">' +
          '<h4>Notes</h4>' +
          '<textarea class="todo-notes-editor" id="tNotes" placeholder="Add context, links, plans...">' + safeNotes + '</textarea>' +
        '</div>' +
        '<div class="detail-section">' +
          '<h4>Attached Sessions (' + attached.length + ')</h4>' +
          attachedHtml +
        '</div>' +
        '<div class="detail-section" style="font-size:11px;color:var(--dim);">' +
          'Created ' + escapeHtml(formatRelativeTime(todo.createdAt)) +
          ' &#183; Updated ' + escapeHtml(formatRelativeTime(todo.updatedAt)) +
        '</div>';

      // Wire actions
      const tEditTitle = document.getElementById('tEditTitle');
      const tSetStatus = document.getElementById('tSetStatus');
      const tAttach = document.getElementById('tAttach');
      const tDelete = document.getElementById('tDelete');
      const tNotes = document.getElementById('tNotes');

      tEditTitle.addEventListener('click', () => {
        vscode.postMessage({ type: 'todoRenamePrompt', todoId: todo.id });
      });
      tSetStatus.addEventListener('click', () => {
        vscode.postMessage({ type: 'todoSetStatus', todoId: todo.id });
      });
      tAttach.addEventListener('click', () => {
        vscode.postMessage({ type: 'todoAttachSession', todoId: todo.id });
      });
      const tAddLink = document.getElementById('tAddLink');
      tAddLink?.addEventListener('click', () => {
        vscode.postMessage({ type: 'todoAddLink', todoId: todo.id });
      });
      tDelete.addEventListener('click', () => {
        vscode.postMessage({ type: 'todoDelete', todoId: todo.id });
      });

      const tLinkAddInline = document.getElementById('tLinkAddInline');
      tLinkAddInline?.addEventListener('click', () => {
        vscode.postMessage({ type: 'todoAddLink', todoId: todo.id });
      });

      todoDetailBody.querySelectorAll('.link-row').forEach(row => {
        const idxAttr = row.getAttribute('data-link-idx');
        const idx = idxAttr !== null ? parseInt(idxAttr, 10) : -1;
        const links = Array.isArray(todo.links) ? todo.links : [];
        row.querySelectorAll('[data-act]').forEach(el => {
          el.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            const act = el.getAttribute('data-act');
            if (idx < 0 || idx >= links.length) { return; }
            if (act === 'open') {
              vscode.postMessage({ type: 'todoOpenLink', url: links[idx] });
            } else if (act === 'edit') {
              vscode.postMessage({ type: 'todoEditLinkAt', todoId: todo.id, index: idx });
            } else if (act === 'remove') {
              vscode.postMessage({ type: 'todoRemoveLinkAt', todoId: todo.id, index: idx });
            }
          });
        });
      });

      // Save notes on blur if changed
      let lastNotes = todo.notes || '';
      tNotes.addEventListener('blur', () => {
        const v = tNotes.value;
        if (v !== lastNotes) {
          lastNotes = v;
          vscode.postMessage({ type: 'todoUpdate', todoId: todo.id, notes: v });
        }
      });

      // Attached session row actions
      todoDetailBody.querySelectorAll('.attached-session-row').forEach(row => {
        const sid = row.getAttribute('data-sid');
        row.querySelectorAll('button').forEach(btn => {
          btn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const act = btn.getAttribute('data-act');
            if (act === 'open') {
              vscode.postMessage({ type: 'openSession', sessionId: sid });
            } else if (act === 'view') {
              setActiveTab('sessions');
              vscode.postMessage({ type: 'viewSession', sessionId: sid });
            } else if (act === 'detach') {
              vscode.postMessage({ type: 'todoDetachSession', todoId: todo.id, sessionId: sid });
            }
          });
        });
      });
    }

    todoBackBtn.addEventListener('click', () => {
      openTodoId = null;
      todoDetailView.classList.remove('active');
      todoListView.style.display = 'block';
      document.getElementById('todosPanel')?.classList.remove('in-detail');
    });

    newTodoBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'todoCreatePrompt' });
    });

    let todoSearchTimeout = null;
    todoSearchInput.addEventListener('input', () => {
      clearTimeout(todoSearchTimeout);
      todoSearchTimeout = setTimeout(() => {
        todoSearchQuery = todoSearchInput.value;
        renderTodoList();
      }, 150);
    });

    todoStatusFilterEl.addEventListener('change', () => {
      todoStatusFilter = todoStatusFilterEl.value;
      renderTodoList();
    });

    vscode.postMessage({ type: 'ready' });
    } catch (e) {
      document.body.innerHTML = '<pre style="color:red;padding:16px;">Script error: ' + e + '\\n' + (e.stack || '') + '</pre>';
    }
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const array = new Uint8Array(16);
  require('crypto').randomFillSync(array);
  return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
}
