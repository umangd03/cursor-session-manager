import * as vscode from 'vscode';
import { CursorDbReader } from './services/cursorDbReader';
import { OverlayStore } from './services/overlayStore';
import { SessionManager } from './services/sessionManager';
import { BackupService } from './services/backupService';
import { SessionSidebarProvider } from './views/sidebarProvider';
import { log } from './services/logger';

export function activate(context: vscode.ExtensionContext) {
  log.init();
  log.info('Activating extension...');

  const storageUri = context.globalStorageUri;
  const dbReader = new CursorDbReader();
  const overlay = new OverlayStore(storageUri);
  const sessionManager = new SessionManager(dbReader, overlay);
  const backupService = new BackupService(storageUri, 'sessions-overlay.json');

  backupService.runDailyBackup();

  const backupInterval = setInterval(() => {
    backupService.runDailyBackup();
  }, 6 * 60 * 60 * 1000); // re-check every 6 hours
  context.subscriptions.push({ dispose: () => clearInterval(backupInterval) });

  const sidebarProvider = new SessionSidebarProvider(
    context.extensionUri,
    sessionManager,
    overlay,
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SessionSidebarProvider.viewType,
      sidebarProvider,
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorSessions.refresh', async () => {
      sessionManager.invalidateCache();
      await sessionManager.refresh();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorSessions.search', async () => {
      const query = await vscode.window.showInputBox({
        prompt: 'Search across all session messages',
        placeHolder: 'e.g., auth token, AISTUDIO-1234, database migration',
      });
      if (query) {
        const results = await sessionManager.searchSessions(query);
        const picks = results.map(s => ({
          label: s.pinned ? `$(pin) ${s.displayName}` : s.displayName,
          description: `${s.metrics.messageCount} msgs | ${new Date(s.lastMessageAt).toLocaleDateString()}`,
          detail: s.tags.length > 0 ? `Tags: ${s.tags.join(', ')}` : undefined,
          sessionId: s.id,
        }));

        const selected = await vscode.window.showQuickPick(picks, {
          placeHolder: `${results.length} sessions found`,
          matchOnDescription: true,
          matchOnDetail: true,
        });

        if (selected) {
          vscode.window.showInformationMessage(`Selected: ${selected.label}`);
        }
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorSessions.pinSession', async () => {
      const sessions = await sessionManager.getSessions();
      const unpinned = sessions.filter(s => !s.pinned);
      const picks = unpinned.map(s => ({
        label: s.displayName,
        description: new Date(s.lastMessageAt).toLocaleDateString(),
        sessionId: s.id,
      }));

      const selected = await vscode.window.showQuickPick(picks, {
        placeHolder: 'Select a session to pin',
      });

      if (selected) {
        await overlay.setPin(selected.sessionId, true);
        vscode.window.showInformationMessage(`Pinned: ${selected.label}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorSessions.unpinSession', async () => {
      const sessions = await sessionManager.getSessions();
      const pinned = sessions.filter(s => s.pinned);
      const picks = pinned.map(s => ({
        label: s.displayName,
        sessionId: s.id,
      }));

      const selected = await vscode.window.showQuickPick(picks, {
        placeHolder: 'Select a session to unpin',
      });

      if (selected) {
        await overlay.setPin(selected.sessionId, false);
        vscode.window.showInformationMessage(`Unpinned: ${selected.label}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorSessions.renameSession', async () => {
      const sessions = await sessionManager.getSessions();
      const picks = sessions.map(s => ({
        label: s.displayName,
        description: s.customName ? `(auto: ${s.autoTitle})` : undefined,
        sessionId: s.id,
      }));

      const selected = await vscode.window.showQuickPick(picks, {
        placeHolder: 'Select a session to rename',
      });

      if (selected) {
        const name = await vscode.window.showInputBox({
          prompt: 'Enter new name',
          value: selected.label,
        });
        if (name !== undefined) {
          await overlay.rename(selected.sessionId, name);
          vscode.window.showInformationMessage(`Renamed to: ${name}`);
        }
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorSessions.tagSession', async () => {
      const sessions = await sessionManager.getSessions();
      const picks = sessions.map(s => ({
        label: s.displayName,
        description: s.tags.length > 0 ? `Tags: ${s.tags.join(', ')}` : undefined,
        sessionId: s.id,
      }));

      const selected = await vscode.window.showQuickPick(picks, {
        placeHolder: 'Select a session to tag',
      });

      if (selected) {
        const existingTags = sessionManager.getAllTags();
        const tag = await vscode.window.showInputBox({
          prompt: 'Enter tag',
          placeHolder: existingTags.length > 0
            ? `Existing: ${existingTags.join(', ')}`
            : 'e.g., bugfix, AISTUDIO-1234',
        });
        if (tag?.trim()) {
          await overlay.addTag(selected.sessionId, tag.trim());
          vscode.window.showInformationMessage(`Tagged "${selected.label}" with: ${tag.trim()}`);
        }
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorSessions.exportSession', async () => {
      const sessions = await sessionManager.getSessions();
      const picks = sessions.map(s => ({
        label: s.displayName,
        description: `${s.metrics.messageCount} msgs`,
        sessionId: s.id,
      }));

      const selected = await vscode.window.showQuickPick(picks, {
        placeHolder: 'Select a session to export',
      });

      if (selected) {
        const format = await vscode.window.showQuickPick(
          [{ label: 'Markdown', value: 'markdown' as const }, { label: 'JSON', value: 'json' as const }],
          { placeHolder: 'Export format' },
        );

        if (format) {
          try {
            const content = await sessionManager.exportSession(selected.sessionId, format.value);
            const ext = format.value === 'markdown' ? 'md' : 'json';
            const uri = await vscode.window.showSaveDialog({
              defaultUri: vscode.Uri.file(`session-export.${ext}`),
              filters: format.value === 'markdown'
                ? { 'Markdown': ['md'] }
                : { 'JSON': ['json'] },
            });
            if (uri) {
              await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
              vscode.window.showInformationMessage(`Exported to ${uri.fsPath}`);
            }
          } catch (err) {
            vscode.window.showErrorMessage(`Export failed: ${err}`);
          }
        }
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorSessions.linkSessions', async () => {
      const sessions = await sessionManager.getSessions();
      const picks = sessions.map(s => ({
        label: s.displayName,
        description: new Date(s.lastMessageAt).toLocaleDateString(),
        sessionId: s.id,
      }));

      const first = await vscode.window.showQuickPick(picks, {
        placeHolder: 'Select the first session',
      });
      if (!first) { return; }

      const remaining = picks.filter(p => p.sessionId !== first.sessionId);
      const second = await vscode.window.showQuickPick(remaining, {
        placeHolder: 'Select sessions to link',
        canPickMany: true,
      });

      if (second) {
        for (const s of second) {
          await overlay.linkSessions(first.sessionId, s.sessionId);
        }
        vscode.window.showInformationMessage(`Linked ${second.length} session(s) to "${first.label}"`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorSessions.setStatus', async () => {
      const { SESSION_STATUS_LABELS } = await import('./models/types');
      type StatusKey = import('./models/types').SessionStatus;

      const sessions = await sessionManager.getSessions();
      const picks = sessions.map(s => {
        const currentLabel = s.status && s.status !== 'none'
          ? SESSION_STATUS_LABELS[s.status] : '';
        return {
          label: s.pinned ? `$(pin) ${s.displayName}` : s.displayName,
          description: currentLabel ? `Current: ${currentLabel}` : undefined,
          sessionId: s.id,
        };
      });

      const selected = await vscode.window.showQuickPick(picks, {
        placeHolder: 'Select a session to set status',
      });
      if (!selected) { return; }

      const entries = Object.entries(SESSION_STATUS_LABELS) as [StatusKey, string][];
      const statusPicks = entries
        .filter(([key]) => key !== 'none')
        .map(([key, label]) => ({ label, statusKey: key }));
      statusPicks.unshift({ label: 'Clear status', statusKey: 'none' as StatusKey });

      const statusChoice = await vscode.window.showQuickPick(statusPicks, {
        placeHolder: 'Set status',
      });
      if (statusChoice) {
        await overlay.setStatus(selected.sessionId, statusChoice.statusKey);
        vscode.window.showInformationMessage(`Status set to: ${statusChoice.label}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorSessions.removeTag', async () => {
      const sessions = await sessionManager.getSessions();
      const tagged = sessions.filter(s => s.tags.length > 0);
      const picks = tagged.map(s => ({
        label: s.displayName,
        description: `Tags: ${s.tags.join(', ')}`,
        sessionId: s.id,
        tags: s.tags,
      }));

      const selected = await vscode.window.showQuickPick(picks, {
        placeHolder: 'Select a session to remove a tag from',
      });
      if (!selected) { return; }

      const tagPicks = selected.tags.map(t => ({ label: t, tag: t }));
      const tagChoice = await vscode.window.showQuickPick(tagPicks, {
        placeHolder: 'Select tag to remove',
        canPickMany: true,
      });
      if (tagChoice) {
        for (const t of tagChoice) {
          await overlay.removeTag(selected.sessionId, t.tag);
        }
        vscode.window.showInformationMessage(`Removed ${tagChoice.length} tag(s)`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorSessions.addBranch', async () => {
      const sessions = await sessionManager.getSessions();
      const picks = sessions.map(s => ({
        label: s.pinned ? `$(pin) ${s.displayName}` : s.displayName,
        description: s.branches.length > 0 ? `Branches: ${s.branches.join(', ')}` : undefined,
        sessionId: s.id,
      }));

      const selected = await vscode.window.showQuickPick(picks, {
        placeHolder: 'Select a session to add a branch to',
      });
      if (!selected) { return; }

      const branch = await vscode.window.showInputBox({
        prompt: 'Enter branch name',
        placeHolder: 'e.g., feature/auth, main, bugfix/AISTUDIO-1234',
      });
      if (branch?.trim()) {
        await overlay.addBranch(selected.sessionId, branch.trim());
        vscode.window.showInformationMessage(`Added branch: ${branch.trim()}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorSessions.removeBranch', async () => {
      const sessions = await sessionManager.getSessions();
      const withBranches = sessions.filter(s => s.branches.length > 0);
      const picks = withBranches.map(s => ({
        label: s.displayName,
        description: `Branches: ${s.branches.join(', ')}`,
        sessionId: s.id,
        branches: s.branches,
      }));

      const selected = await vscode.window.showQuickPick(picks, {
        placeHolder: 'Select a session to remove a branch from',
      });
      if (!selected) { return; }

      const branchPicks = selected.branches.map(b => ({ label: b, branch: b }));
      const branchChoice = await vscode.window.showQuickPick(branchPicks, {
        placeHolder: 'Select branch(es) to remove',
        canPickMany: true,
      });
      if (branchChoice) {
        for (const b of branchChoice) {
          await overlay.removeBranch(selected.sessionId, b.branch);
        }
        vscode.window.showInformationMessage(`Removed ${branchChoice.length} branch(es)`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorSessions.restoreDeleted', async () => {
      const count = overlay.getHiddenCount();
      if (count === 0) {
        vscode.window.showInformationMessage('No deleted sessions to restore.');
        return;
      }
      const answer = await vscode.window.showInformationMessage(
        `Restore ${count} deleted session(s)? They will reappear in your session list.`,
        'Restore All',
        'Cancel',
      );
      if (answer === 'Restore All') {
        const restored = await overlay.unhideAll();
        sessionManager.invalidateCache();
        vscode.window.showInformationMessage(`Restored ${restored} session(s).`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorSessions.restoreFromBackup', async () => {
      const backups = backupService.listBackups();
      if (backups.length === 0) {
        vscode.window.showInformationMessage('No backups available. Backups are created daily and kept for 14 days.');
        return;
      }
      const picks = backups.map(b => ({
        label: b.date.toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }),
        description: `${(b.sizeBytes / 1024).toFixed(1)} KB`,
        detail: b.filename,
        backupPath: b.fullPath,
      }));
      const selected = await vscode.window.showQuickPick(picks, {
        placeHolder: 'Select a backup to restore from',
      });
      if (!selected) { return; }
      const confirm = await vscode.window.showWarningMessage(
        `Restore session data from ${selected.label}? Your current data will be backed up first.`,
        { modal: true, detail: 'A snapshot of your current data will be saved before restoring.' },
        'Restore',
      );
      if (confirm === 'Restore') {
        try {
          await backupService.restoreFromBackup(selected.backupPath);
          overlay.reload();
          sessionManager.invalidateCache();
          vscode.window.showInformationMessage(`Restored from ${selected.label}. Refresh the sidebar to see changes.`);
        } catch (err) {
          vscode.window.showErrorMessage(`Restore failed: ${err}`);
        }
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorSessions.debugCommands', async () => {
      const allCommands = await vscode.commands.getCommands(true);
      const chatCommands = allCommands.filter(c =>
        c.includes('composer') || c.includes('aichat') || c.includes('aipane') ||
        c.includes('chat.open') || c.includes('openChat')
      ).sort();

      const doc = await vscode.workspace.openTextDocument({
        content: `# Cursor Chat Commands (${chatCommands.length} found)\n\n${chatCommands.join('\n')}`,
        language: 'markdown',
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    }),
  );

  context.subscriptions.push({
    dispose() {
      overlay.dispose();
      sessionManager.dispose();
    },
  });

  log.info('Extension activated');
}

export function deactivate() {
  console.log('[CursorSessionManager] Deactivated');
}
