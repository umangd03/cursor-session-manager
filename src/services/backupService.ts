import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { log } from './logger';

const BACKUP_DIR = 'backups';
const MAX_BACKUP_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const MIN_BACKUP_INTERVAL_MS = 20 * 60 * 60 * 1000; // 20 hours (prevents duplicates near midnight)

export interface BackupEntry {
  filename: string;
  date: Date;
  sizeBytes: number;
  fullPath: string;
}

export class BackupService {
  private readonly backupDir: string;
  private readonly sourceFile: string;

  constructor(storageUri: vscode.Uri, sourceFilename: string) {
    const storageRoot = storageUri.fsPath;
    this.backupDir = path.join(storageRoot, BACKUP_DIR);
    this.sourceFile = path.join(storageRoot, sourceFilename);
  }

  async runDailyBackup(): Promise<void> {
    try {
      if (!fs.existsSync(this.sourceFile)) { return; }

      if (!fs.existsSync(this.backupDir)) {
        fs.mkdirSync(this.backupDir, { recursive: true });
      }

      if (!this.needsBackup()) {
        log.info('Backup: skipping, recent backup exists');
        return;
      }

      const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const backupName = `overlay-${dateStr}.json`;
      const backupPath = path.join(this.backupDir, backupName);

      fs.copyFileSync(this.sourceFile, backupPath);
      log.info(`Backup: created ${backupName}`);

      this.pruneOldBackups();
    } catch (err) {
      log.error('Backup: failed to create daily backup', err);
    }
  }

  private needsBackup(): boolean {
    const backups = this.listBackups();
    if (backups.length === 0) { return true; }
    const latest = backups[0];
    return Date.now() - latest.date.getTime() > MIN_BACKUP_INTERVAL_MS;
  }

  private pruneOldBackups(): void {
    const cutoff = Date.now() - MAX_BACKUP_AGE_MS;
    const backups = this.listBackups();
    let pruned = 0;
    for (const b of backups) {
      if (b.date.getTime() < cutoff) {
        try {
          fs.unlinkSync(b.fullPath);
          pruned++;
        } catch { /* ignore individual failures */ }
      }
    }
    if (pruned > 0) {
      log.info(`Backup: pruned ${pruned} backup(s) older than 14 days`);
    }
  }

  listBackups(): BackupEntry[] {
    if (!fs.existsSync(this.backupDir)) { return []; }
    const entries: BackupEntry[] = [];
    for (const name of fs.readdirSync(this.backupDir)) {
      const match = name.match(/^overlay-(\d{4}-\d{2}-\d{2})\.json$/);
      if (!match) { continue; }
      const fullPath = path.join(this.backupDir, name);
      try {
        const stat = fs.statSync(fullPath);
        entries.push({
          filename: name,
          date: new Date(match[1]),
          sizeBytes: stat.size,
          fullPath,
        });
      } catch { /* skip unreadable */ }
    }
    entries.sort((a, b) => b.date.getTime() - a.date.getTime());
    return entries;
  }

  async restoreFromBackup(backupPath: string): Promise<void> {
    if (!fs.existsSync(backupPath)) {
      throw new Error('Backup file not found');
    }

    const raw = fs.readFileSync(backupPath, 'utf-8');
    JSON.parse(raw); // validate JSON before overwriting

    const preRestoreBackup = path.join(
      this.backupDir,
      `overlay-pre-restore-${Date.now()}.json`,
    );
    if (fs.existsSync(this.sourceFile)) {
      if (!fs.existsSync(this.backupDir)) {
        fs.mkdirSync(this.backupDir, { recursive: true });
      }
      fs.copyFileSync(this.sourceFile, preRestoreBackup);
      log.info(`Backup: saved pre-restore snapshot as ${path.basename(preRestoreBackup)}`);
    }

    fs.writeFileSync(this.sourceFile, raw, 'utf-8');
    log.info(`Backup: restored from ${path.basename(backupPath)}`);
  }
}
