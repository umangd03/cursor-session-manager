import * as vscode from 'vscode';
import * as fs from 'fs';
import { OverlayMetadata, OverlayStore as OverlayStoreData, SessionGroup, SessionStatus } from '../models/types';

const STORE_FILENAME = 'sessions-overlay.json';
const CURRENT_VERSION = 1;

export class OverlayStore {
  private data: OverlayStoreData;
  private storePath: string;
  private dirty = false;

  private readonly _onDidChange = new vscode.EventEmitter<string | undefined>();
  readonly onDidChange = this._onDidChange.event;

  constructor(storageUri: vscode.Uri) {
    this.storePath = vscode.Uri.joinPath(storageUri, STORE_FILENAME).fsPath;
    this.data = this.load();
  }

  private load(): OverlayStoreData {
    try {
      if (fs.existsSync(this.storePath)) {
        const raw = fs.readFileSync(this.storePath, 'utf-8');
        const parsed = JSON.parse(raw) as OverlayStoreData;
        if (parsed.version === CURRENT_VERSION) {
          this.migrateGitBranchToBranches(parsed);
          return parsed;
        }
      }
    } catch (err) {
      console.error('[OverlayStore] Failed to load:', err);
    }
    return { version: CURRENT_VERSION, sessions: {}, groups: {} };
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

  async save(): Promise<void> {
    if (!this.dirty) { return; }
    try {
      const dir = require('path').dirname(this.storePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.storePath, JSON.stringify(this.data, null, 2), 'utf-8');
      this.dirty = false;
    } catch (err) {
      console.error('[OverlayStore] Failed to save:', err);
    }
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

  dispose(): void {
    if (this.dirty) {
      try {
        const dir = require('path').dirname(this.storePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(this.storePath, JSON.stringify(this.data, null, 2), 'utf-8');
      } catch { /* best effort on dispose */ }
    }
    this._onDidChange.dispose();
  }
}
