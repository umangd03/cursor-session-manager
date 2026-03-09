import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import initSqlJs from 'sql.js/dist/sql-asm.js';
import type { Database } from 'sql.js';
import { CursorRawSession, CursorRawMessage } from '../models/types';
import { log } from './logger';

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

  async readAllSessions(): Promise<CursorRawSession[]> {
    try {
      const allSessions: CursorRawSession[] = [];
      const seenIds = new Set<string>();

      log.info('readAllSessions: scanning workspaces...');
      const workspaces = this.getAvailableWorkspaces().slice(0, 20);
      log.info(`readAllSessions: found ${workspaces.length} workspaces`);

      for (const ws of workspaces) {
        log.info(`readAllSessions: reading workspace ${ws.hash} (${ws.folderPath ?? 'unknown path'})`);
        const composerSessions = await this.readComposerData(ws.dbPath, ws.folderPath);
        log.info(`readAllSessions: workspace ${ws.hash} yielded ${composerSessions.length} sessions`);
        for (const session of composerSessions) {
          if (!seenIds.has(session.id)) {
            seenIds.add(session.id);
            allSessions.push(session);
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

  private async readComposerData(
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
    if (!projectHash) { return []; }

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

    return [];
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
