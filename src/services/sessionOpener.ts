import * as vscode from 'vscode';
import { Session } from '../models/types';

const COMPOSER_OPEN_COMMANDS = [
  'aipane.aichat.openTab',
  'composerAction.openComposerTab',
  'composerAction.openComposer',
  'aipane.openChat',
  'workbench.action.aichat.openTab',
  'aichat.openTab',
  'composer.openComposer',
];

let cachedOpenCommand: string | null | undefined;

async function discoverOpenCommand(): Promise<string | null> {
  if (cachedOpenCommand !== undefined) { return cachedOpenCommand; }

  const allCommands = await vscode.commands.getCommands(true);
  const chatCommands = allCommands.filter(c =>
    c.includes('composer') || c.includes('aichat') || c.includes('aipane')
  );
  console.log('[CursorSessionManager] Available chat commands:', chatCommands.join(', '));

  for (const cmd of COMPOSER_OPEN_COMMANDS) {
    if (allCommands.includes(cmd)) {
      console.log(`[CursorSessionManager] Found open command: ${cmd}`);
      cachedOpenCommand = cmd;
      return cmd;
    }
  }

  const openCandidate = chatCommands.find(c =>
    c.includes('open') && (c.includes('tab') || c.includes('chat') || c.includes('composer'))
  );
  if (openCandidate) {
    console.log(`[CursorSessionManager] Found candidate open command: ${openCandidate}`);
    cachedOpenCommand = openCandidate;
    return openCandidate;
  }

  cachedOpenCommand = null;
  return null;
}

export async function openSessionInChat(session: Session): Promise<boolean> {
  const openCmd = await discoverOpenCommand();

  if (openCmd) {
    try {
      await vscode.commands.executeCommand(openCmd, session.id);
      return true;
    } catch (err) {
      console.warn(`[CursorSessionManager] Command ${openCmd} failed with id arg:`, err);
    }

    try {
      await vscode.commands.executeCommand(openCmd, { composerId: session.id });
      return true;
    } catch (err) {
      console.warn(`[CursorSessionManager] Command ${openCmd} failed with object arg:`, err);
    }
  }

  return false;
}

export async function openSessionAsDocument(session: Session, preview = false): Promise<void> {
  const lines: string[] = [];
  lines.push(`# ${session.displayName}`);
  lines.push('');

  const meta: string[] = [];
  if (session.branches.length > 0) { meta.push(`**Branches:** ${session.branches.join(', ')}`); }
  meta.push(`**Messages:** ${session.metrics.messageCount}`);
  meta.push(`**Created:** ${new Date(session.createdAt).toLocaleString()}`);
  meta.push(`**Last active:** ${new Date(session.lastMessageAt).toLocaleString()}`);
  if (session.tags.length > 0) { meta.push(`**Tags:** ${session.tags.join(', ')}`); }
  if (session.metrics.codeBlockCount > 0) {
    meta.push(`**Code blocks:** ${session.metrics.codeBlockCount}`);
  }
  lines.push(meta.join('  \n'));
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of session.messages) {
    if (msg.role === 'user') {
      const content = msg.content
        .replace(/<user_query>\n?/g, '')
        .replace(/<\/user_query>/g, '')
        .trim();
      if (!content) { continue; }
      lines.push('## You');
      lines.push('');
      lines.push(content);
    } else if (msg.role === 'assistant') {
      lines.push('## Assistant');
      lines.push('');
      lines.push(msg.content);
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  const doc = await vscode.workspace.openTextDocument({
    content: lines.join('\n'),
    language: 'markdown',
  });
  await vscode.window.showTextDocument(doc, { preview });
}

export async function openSession(session: Session): Promise<void> {
  const opened = await openSessionInChat(session);
  if (!opened) {
    await openSessionAsDocument(session);
  }
}
