import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export const log = {
  init() {
    if (!channel) {
      channel = vscode.window.createOutputChannel('Cursor Sessions');
    }
  },

  info(msg: string) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    channel?.appendLine(line);
    console.log(`[CursorSessions] ${msg}`);
  },

  error(msg: string, err?: unknown) {
    const line = `[${new Date().toISOString()}] ERROR: ${msg}${err ? ` -- ${err}` : ''}`;
    channel?.appendLine(line);
    console.error(`[CursorSessions] ${msg}`, err);
  },

  show() {
    channel?.show(true);
  },
};
