import * as vscode from 'vscode';

/** JIRA issue key, e.g. `AISTUDIO-1234` or `proj-42`. Case-insensitive match. */
const TICKET_KEY_REGEX = /^[A-Za-z][A-Za-z0-9]+-\d+$/;

/**
 * Atlassian ticket paths we strip when normalizing a pasted URL back to just
 * the instance origin (e.g. `/browse/AIPDQ-14091`, `/jira/software/c/projects/X/issues/...`).
 */
const TICKET_PATH_REGEX = /\/(?:browse|issues)\/[A-Za-z][A-Za-z0-9]+-\d+(?:\/.*)?$/i;

/** Read the configured Atlassian/JIRA base URL, or an empty string when unset. */
export function getJiraBaseUrl(): string {
  const cfg = vscode.workspace.getConfiguration('cursorSessions');
  return (cfg.get<string>('jiraBaseUrl') ?? '').trim();
}

/**
 * Normalize whatever the user pasted into a clean base URL.
 *
 * Accepts:
 * - `https://cisco-sbg.atlassian.net`
 * - `https://cisco-sbg.atlassian.net/`
 * - `https://cisco-sbg.atlassian.net/browse/AIPDQ-14091`  (ticket URL copy/paste)
 *
 * Returns a string without a trailing slash, or the original input when it is
 * not a parseable http(s) URL (so the caller can surface a validation error).
 */
export function normalizeJiraBaseUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) { return ''; }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return trimmed;
  }
  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = parsed.pathname.replace(TICKET_PATH_REGEX, '');
  const cleaned = `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
  return cleaned;
}

/**
 * Validate that a string is a safe http(s) base URL we can interpolate tickets into.
 * Returns an error message string on failure, or undefined when the value is OK.
 */
export function validateJiraBaseUrl(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) { return undefined; }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return 'Enter a full URL, e.g., https://yourcompany.atlassian.net';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return 'Only http(s) URLs are supported';
  }
  if (!parsed.host) {
    return 'Missing host (e.g., yourcompany.atlassian.net)';
  }
  return undefined;
}

/**
 * Build a safe browser URL for a JIRA ticket from the configured base URL and
 * a user-supplied ticket key. Returns undefined when either input is invalid.
 *
 * Guard rails:
 * - Base URL must be parseable with http(s) protocol (no `javascript:`, etc.).
 * - A pasted ticket URL used as the base is normalized back to the origin so
 *   we don't build `/browse/X-1/browse/Y-2`.
 * - Ticket key must match the standard `PROJ-123` shape; keys are upper-cased
 *   and URL-encoded before interpolation to avoid path injection.
 */
export function buildJiraTicketUrl(baseUrl: string, ticket: string): string | undefined {
  const trimmedBase = baseUrl.trim();
  if (!trimmedBase) { return undefined; }
  let parsed: URL;
  try {
    parsed = new URL(trimmedBase);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return undefined;
  }
  const key = ticket.trim().toUpperCase();
  if (!TICKET_KEY_REGEX.test(key)) { return undefined; }
  const origin = `${parsed.protocol}//${parsed.host}`;
  const basePath = parsed.pathname.replace(TICKET_PATH_REGEX, '').replace(/\/+$/, '');
  return `${origin}${basePath}/browse/${encodeURIComponent(key)}`;
}

/**
 * Prompt the user for their JIRA/Atlassian base URL and persist it at the
 * Global (user) scope. Accepts a pasted ticket URL and normalizes it back to
 * the origin so setup is a single paste.
 */
export async function configureJiraBaseUrl(): Promise<boolean> {
  const current = getJiraBaseUrl();
  const raw = await vscode.window.showInputBox({
    title: 'Configure JIRA / Atlassian base URL',
    prompt: 'Paste your instance URL. A full ticket URL works too.',
    placeHolder: 'https://yourcompany.atlassian.net',
    value: current,
    ignoreFocusOut: true,
    validateInput: (val) => validateJiraBaseUrl(val),
  });
  if (raw === undefined) { return false; }
  const normalized = normalizeJiraBaseUrl(raw);
  const cfg = vscode.workspace.getConfiguration('cursorSessions');
  await cfg.update('jiraBaseUrl', normalized, vscode.ConfigurationTarget.Global);
  if (normalized) {
    vscode.window.showInformationMessage(
      `JIRA base URL set to ${normalized}. Ticket keys like PROJ-123 will now link to ${normalized}/browse/PROJ-123.`,
    );
  } else {
    vscode.window.showInformationMessage('JIRA base URL cleared. Ticket links are now disabled.');
  }
  return true;
}

/**
 * Open the JIRA ticket for `ticket` in the user's external browser, surfacing
 * actionable errors when configuration is missing or inputs are malformed.
 */
export async function openJiraTicket(ticket: string): Promise<void> {
  const base = getJiraBaseUrl();
  if (!base) {
    const action = await vscode.window.showWarningMessage(
      'JIRA base URL is not configured. Set it once to enable ticket links.',
      'Configure...',
      'Open Settings',
    );
    if (action === 'Configure...') {
      const saved = await configureJiraBaseUrl();
      if (saved && getJiraBaseUrl()) {
        await openJiraTicket(ticket);
      }
    } else if (action === 'Open Settings') {
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        'cursorSessions.jiraBaseUrl',
      );
    }
    return;
  }
  const target = buildJiraTicketUrl(base, ticket);
  if (!target) {
    vscode.window.showErrorMessage(
      `Could not open ${ticket}. Check that "cursorSessions.jiraBaseUrl" is a valid http(s) URL and the ticket has the form PROJ-123.`,
    );
    return;
  }
  await vscode.env.openExternal(vscode.Uri.parse(target));
}
