import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import initSqlJs from 'sql.js/dist/sql-asm.js';
import type { Database } from 'sql.js';
import { CursorRawSession, CursorRawMessage } from '../models/types';
import { log } from './logger';

const execFileAsync = promisify(execFile);

function getCursorDataDir(): string {
  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User');
    case 'win32':
      return path.join(process.env.APPDATA ?? '', 'Cursor', 'User');
    case 'linux':
      return path.join(os.homedir(), '.config', 'Cursor', 'User');
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

function getWorkspaceStorageDir(): string {
  return path.join(getCursorDataDir(), 'workspaceStorage');
}

function getCursorProjectsDir(): string {
  return path.join(os.homedir(), '.cursor', 'projects');
}

interface ComposerEntry {
  composerId: string;
  name?: string | null;
  createdAt?: number;
  lastUpdatedAt?: number;
  subtitle?: string | null;
  unifiedMode?: string;
  totalLinesAdded?: number;
  totalLinesRemoved?: number;
  filesChangedCount?: number;
  committedToBranch?: string;
  activeBranch?: { branchName: string };
  branches?: { branchName: string }[];
  isArchived?: boolean;
  workspaceIdentifier?: {
    id?: string;
    uri?: { fsPath?: string; path?: string };
  };
}

interface WorkspaceInfo {
  hash: string;
  dbPath: string;
  folderPath?: string;
  lastModified: Date;
}

let sqlPromise: ReturnType<typeof initSqlJs> | null = null;

function getSql(): ReturnType<typeof initSqlJs> {
  if (!sqlPromise) {
    sqlPromise = initSqlJs();
  }
  return sqlPromise;
}

export class CursorDbReader {
  // Cache of composerId -> transcript file path. Built lazily by scanning
  // ~/.cursor/projects/<workspace>/agent-transcripts. Keyed by composer id so
  // we do not depend on Cursor's (fragile) workspace-path-to-folder-name
  // mapping, which lossily replaces underscores with hyphens.
  private transcriptIndex: Map<string, string> | null = null;

  getAvailableWorkspaces(): WorkspaceInfo[] {
    const results: WorkspaceInfo[] = [];
    const wsDir = getWorkspaceStorageDir();
    if (!fs.existsSync(wsDir)) { return results; }

    for (const entry of fs.readdirSync(wsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) { continue; }
      const dbPath = path.join(wsDir, entry.name, 'state.vscdb');
      if (!fs.existsSync(dbPath)) { continue; }

      const stat = fs.statSync(dbPath);
      const info: WorkspaceInfo = {
        hash: entry.name,
        dbPath,
        lastModified: stat.mtime,
      };

      const wsJsonPath = path.join(wsDir, entry.name, 'workspace.json');
      try {
        if (fs.existsSync(wsJsonPath)) {
          const wsData = JSON.parse(fs.readFileSync(wsJsonPath, 'utf-8'));
          const folder = wsData.folder as string | undefined;
          if (folder) {
            info.folderPath = folder.replace('file://', '');
          }
        }
      } catch { /* workspace.json may be malformed */ }

      results.push(info);
    }

    return results.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  }

  /**
   * Returns the composerId of the session that Cursor most recently focused
   * for one of the provided workspace folder paths. We read each workspace's
   * `state.vscdb` and pick `lastFocusedComposerIds[0]` from the workspace whose
   * DB file was modified most recently. This lets us track Cursor's native
   * session selection in real time across multiple windows.
   */
  async getActiveSessionId(currentFolderPaths: string[]): Promise<string | undefined> {
    try {
      const workspaces = this.getAvailableWorkspaces();
      if (workspaces.length === 0) { return undefined; }

      const normalized = new Set(currentFolderPaths.map(p => path.resolve(p)));
      const matching = normalized.size > 0
        ? workspaces.filter(w => w.folderPath && normalized.has(path.resolve(w.folderPath)))
        : [];

      const candidates = matching.length > 0 ? matching : workspaces.slice(0, 1);
      candidates.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());

      for (const ws of candidates) {
        const id = await this.readActiveFromWorkspaceDb(ws.dbPath);
        if (id) { return id; }
      }
      return undefined;
    } catch (err) {
      log.error('getActiveSessionId failed', err);
      return undefined;
    }
  }

  private async readActiveFromWorkspaceDb(dbPath: string): Promise<string | undefined> {
    let db: Database | null = null;
    try {
      const SQL = await getSql();
      const buffer = fs.readFileSync(dbPath);
      db = new SQL.Database(buffer);
      const results = db.exec("SELECT value FROM ItemTable WHERE key = 'composer.composerData'");
      if (!results.length || !results[0].values.length) { return undefined; }
      const rawValue = results[0].values[0][0];
      if (typeof rawValue !== 'string') { return undefined; }
      const data = JSON.parse(rawValue);
      const ids = data?.lastFocusedComposerIds;
      if (Array.isArray(ids) && ids.length > 0 && typeof ids[0] === 'string') {
        return ids[0];
      }
      return undefined;
    } catch (err) {
      log.error('readActiveFromWorkspaceDb failed', err);
      return undefined;
    } finally {
      try { db?.close(); } catch { /* ignore */ }
    }
  }

  async readAllSessions(): Promise<CursorRawSession[]> {
    try {
      this.transcriptIndex = null;
      const allSessions: CursorRawSession[] = [];
      const seenIds = new Set<string>();

      const globalSessions = await this.readGlobalComposerHeaders();
      log.info(`readAllSessions: global DB yielded ${globalSessions.length} sessions`);
      for (const s of globalSessions) {
        seenIds.add(s.id);
        allSessions.push(s);
      }

      if (allSessions.length === 0) {
        log.info('readAllSessions: global DB empty, falling back to workspace DBs...');
        const workspaces = this.getAvailableWorkspaces().slice(0, 20);
        for (const ws of workspaces) {
          const composerSessions = await this.readWorkspaceComposerData(ws.dbPath, ws.folderPath);
          for (const session of composerSessions) {
            if (!seenIds.has(session.id)) {
              seenIds.add(session.id);
              allSessions.push(session);
            }
          }
        }
      }

      log.info(`readAllSessions: total ${allSessions.length} unique sessions`);
      return allSessions.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    } catch (err) {
      log.error('readAllSessions failed', err);
      return [];
    }
  }

  private async queryLargeDb(dbPath: string, key: string): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync('sqlite3', [
        dbPath,
        `SELECT value FROM ItemTable WHERE key = '${key}'`,
      ], { maxBuffer: 50 * 1024 * 1024 });
      return stdout.trim() || undefined;
    } catch (err) {
      log.error(`sqlite3 CLI query failed for ${key}`, err);
      return undefined;
    }
  }

  private async readGlobalComposerHeaders(): Promise<CursorRawSession[]> {
    const globalDbPath = path.join(getCursorDataDir(), 'globalStorage', 'state.vscdb');
    if (!fs.existsSync(globalDbPath)) { return []; }

    try {
      const rawValue = await this.queryLargeDb(globalDbPath, 'composer.composerHeaders');
      if (!rawValue) {
        log.info('Global DB: composerHeaders not found or empty');
        return [];
      }

      const data = JSON.parse(rawValue);
      const composers: ComposerEntry[] = data?.allComposers ?? [];
      log.info(`Global DB: parsed ${composers.length} composers`);
      const sessions: CursorRawSession[] = [];

      for (const entry of composers) {
        if (!entry.composerId) { continue; }

        const folderPath = entry.workspaceIdentifier?.uri?.fsPath
          ?? entry.workspaceIdentifier?.uri?.path;
        const projectHash = folderPath ? this.folderToProjectHash(folderPath) : undefined;
        const messages = this.loadMessagesForSessionDirect(entry.composerId, projectHash);

        const title = entry.name
          ?? entry.subtitle
          ?? this.generateTitle(messages);

        const createdAt = entry.createdAt ?? Date.now();
        const lastMessageAt = entry.lastUpdatedAt ?? createdAt;

        const gitBranch = entry.activeBranch?.branchName
          ?? entry.committedToBranch
          ?? entry.branches?.[0]?.branchName;

        sessions.push({
          id: entry.composerId,
          title: title || 'Untitled Session',
          messages,
          createdAt,
          lastMessageAt,
          gitBranch,
          linesAdded: entry.totalLinesAdded,
          linesRemoved: entry.totalLinesRemoved,
          filesChanged: entry.filesChangedCount,
          mode: entry.unifiedMode,
          subtitle: entry.subtitle ?? undefined,
          workspacePath: folderPath,
        });
      }

      return sessions;
    } catch (err) {
      log.error('Failed to read global composerHeaders', err);
      return [];
    }
  }

  private async readWorkspaceComposerData(
    dbPath: string,
    folderPath: string | undefined,
  ): Promise<CursorRawSession[]> {
    let db: Database | null = null;

    try {
      const SQL = await getSql();
      const buffer = fs.readFileSync(dbPath);
      db = new SQL.Database(buffer);

      const results = db.exec("SELECT value FROM ItemTable WHERE key = 'composer.composerData'");
      if (!results.length || !results[0].values.length) { return []; }

      const rawValue = results[0].values[0][0];
      if (typeof rawValue !== 'string') { return []; }

      const data = JSON.parse(rawValue);
      const composers: ComposerEntry[] = data?.allComposers ?? [];
      const sessions: CursorRawSession[] = [];

      const projectHash = folderPath ? this.folderToProjectHash(folderPath) : undefined;

      for (const entry of composers) {
        if (!entry.composerId) { continue; }

        const messages = this.loadMessagesForSessionDirect(entry.composerId, projectHash);

        const title = entry.name
          ?? entry.subtitle
          ?? this.generateTitle(messages);

        const createdAt = entry.createdAt ?? Date.now();
        const lastMessageAt = entry.lastUpdatedAt ?? createdAt;

        const gitBranch = entry.activeBranch?.branchName
          ?? entry.committedToBranch
          ?? entry.branches?.[0]?.branchName;

        sessions.push({
          id: entry.composerId,
          title: title || 'Untitled Session',
          messages,
          createdAt,
          lastMessageAt,
          gitBranch,
          linesAdded: entry.totalLinesAdded,
          linesRemoved: entry.totalLinesRemoved,
          filesChanged: entry.filesChangedCount,
          mode: entry.unifiedMode,
          subtitle: entry.subtitle ?? undefined,
          workspacePath: folderPath,
        });
      }

      return sessions;
    } catch (err) {
      log.error(`Failed to read ${dbPath}`, err);
      return [];
    } finally {
      db?.close();
    }
  }

  private loadMessagesForSessionDirect(
    composerId: string,
    projectHash: string | undefined,
  ): CursorRawMessage[] {
    // Fast path: if the naive folder-name mapping works, use it without the
    // full directory scan.
    if (projectHash) {
      const projectsDir = getCursorProjectsDir();
      const transcriptsBase = path.join(projectsDir, projectHash, 'agent-transcripts');
      const jsonlPath = path.join(transcriptsBase, composerId, `${composerId}.jsonl`);
      if (fs.existsSync(jsonlPath)) {
        return this.parseTranscriptFile(jsonlPath);
      }
      const txtPath = path.join(transcriptsBase, `${composerId}.txt`);
      if (fs.existsSync(txtPath)) {
        return this.parseTranscriptFile(txtPath);
      }
    }

    // Robust fallback: scan all project directories for a matching composer
    // id. Cursor's folder-name mapping is lossy (e.g. `_` becomes `-`), and
    // some workspaces get stored under opaque numeric ids instead of the
    // human-readable path, so indexing by composer id is the only reliable
    // lookup.
    const indexed = this.getTranscriptIndex().get(composerId);
    if (indexed) {
      return this.parseTranscriptFile(indexed);
    }
    return [];
  }

  private getTranscriptIndex(): Map<string, string> {
    if (this.transcriptIndex) { return this.transcriptIndex; }
    const index = new Map<string, string>();
    const projectsDir = getCursorProjectsDir();
    if (!fs.existsSync(projectsDir)) {
      this.transcriptIndex = index;
      return index;
    }

    let projectDirs: fs.Dirent[] = [];
    try {
      projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true });
    } catch (err) {
      log.error(`Failed to list ${projectsDir}`, err);
      this.transcriptIndex = index;
      return index;
    }

    for (const project of projectDirs) {
      if (!project.isDirectory()) { continue; }
      const transcriptsBase = path.join(projectsDir, project.name, 'agent-transcripts');
      if (!fs.existsSync(transcriptsBase)) { continue; }

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(transcriptsBase, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (entry.isDirectory()) {
          // {composerId}/{composerId}.jsonl (current layout)
          const jsonlPath = path.join(transcriptsBase, entry.name, `${entry.name}.jsonl`);
          if (!index.has(entry.name) && fs.existsSync(jsonlPath)) {
            index.set(entry.name, jsonlPath);
          }
        } else if (entry.isFile() && entry.name.endsWith('.txt')) {
          // Legacy {composerId}.txt layout
          const id = entry.name.slice(0, -4);
          if (!index.has(id)) {
            index.set(id, path.join(transcriptsBase, entry.name));
          }
        }
      }
    }

    log.info(`Transcript index: found ${index.size} transcripts across ${projectDirs.length} project dirs`);
    this.transcriptIndex = index;
    return index;
  }

  private parseTranscriptFile(filePath: string): CursorRawMessage[] {
    try {
      if (filePath.endsWith('.jsonl')) {
        return this.parseJsonlTranscript(filePath);
      }
      return this.parseTxtTranscript(filePath);
    } catch (err) {
      log.error(`Failed to parse transcript ${filePath}`, err);
      return [];
    }
  }

  private parseJsonlTranscript(filePath: string): CursorRawMessage[] {
    const content = fs.readFileSync(filePath, 'utf-8');
    const messages: CursorRawMessage[] = [];

    for (const line of content.split('\n')) {
      if (!line.trim()) { continue; }
      try {
        const obj = JSON.parse(line);
        const role = this.normalizeRole(obj.role);
        const text = this.extractJsonlContent(obj);
        if (text) {
          messages.push({ role, content: text });
        }
      } catch { /* skip malformed lines */ }
    }

    return messages;
  }

  private extractJsonlContent(obj: Record<string, unknown>): string {
    const message = obj.message as Record<string, unknown> | undefined;
    if (!message) { return ''; }

    const content = message.content;
    if (typeof content === 'string') { return content; }

    if (Array.isArray(content)) {
      const textParts: string[] = [];
      for (const part of content) {
        if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
          textParts.push(part.text);
        }
      }
      return textParts.join('\n');
    }

    return '';
  }

  private parseTxtTranscript(filePath: string): CursorRawMessage[] {
    const content = fs.readFileSync(filePath, 'utf-8');
    const messages: CursorRawMessage[] = [];
    let currentRole: 'user' | 'assistant' | null = null;
    let currentContent: string[] = [];

    for (const line of content.split('\n')) {
      if (line.startsWith('user:')) {
        if (currentRole && currentContent.length > 0) {
          messages.push({ role: currentRole, content: currentContent.join('\n').trim() });
        }
        currentRole = 'user';
        currentContent = [line.slice(5)];
      } else if (line.startsWith('A:') || line.startsWith('assistant:')) {
        if (currentRole && currentContent.length > 0) {
          messages.push({ role: currentRole, content: currentContent.join('\n').trim() });
        }
        currentRole = 'assistant';
        const prefix = line.startsWith('A:') ? 2 : 10;
        currentContent = [line.slice(prefix)];
      } else {
        currentContent.push(line);
      }
    }

    if (currentRole && currentContent.length > 0) {
      messages.push({ role: currentRole, content: currentContent.join('\n').trim() });
    }

    return messages;
  }

  private folderToProjectHash(folderPath: string): string | undefined {
    const normalized = folderPath.replace(/^\//, '').replace(/\//g, '-');
    const projectsDir = getCursorProjectsDir();
    const candidate = path.join(projectsDir, normalized);
    if (fs.existsSync(candidate)) {
      return normalized;
    }
    return undefined;
  }

  private normalizeRole(raw: unknown): 'user' | 'assistant' | 'system' {
    const str = String(raw).toLowerCase();
    if (str === 'user' || str === 'human') { return 'user'; }
    if (str === 'system') { return 'system'; }
    return 'assistant';
  }

  private generateTitle(messages: CursorRawMessage[]): string {
    const firstUser = messages.find(m => m.role === 'user');
    if (!firstUser) { return 'Untitled Session'; }
    const cleaned = firstUser.content
      .replace(/<user_query>\n?/g, '')
      .replace(/<\/user_query>/g, '')
      .trim();
    const text = cleaned.slice(0, 80);
    return text.length < cleaned.length ? `${text}...` : text;
  }
}
