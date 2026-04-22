# Cursor Session Manager

Enhanced session management for Cursor IDE — search, tag, pin, track status, and organize your agent chat sessions.

## Features

### Search & Browse
- **Full-text search** across all session messages, titles, tags, and branches
- **Time-grouped list** — sessions organized by Today, Yesterday, This Week, This Month, and Older
- **Session detail view** with conversation preview, metrics, and metadata

### Organize
- **Rename sessions** with custom names for easy identification
- **Tag sessions** with labels (e.g., `AISTUDIO-1234`, `bugfix`, `deepagent`) — add and remove tags freely
- **Pin/bookmark** important sessions to the top of the list
- **Filter by tag** — click any tag to filter the session list
- **Link related sessions** to create relationships between conversations
- **Group sessions** into custom named groups
- **Multi-select and bulk delete** — flip on Select mode in the sidebar, check any number of sessions, and delete them in one go (restorable from the deleted-sessions banner)

### JIRA Integration
- **Auto-linked tickets** — any `PROJ-123` style key found in a session's name, custom title, or tags is surfaced as a clickable badge
- **One-click setup** via `Sessions: Configure JIRA Base URL…` (accepts a pasted ticket URL — we normalize back to the origin)
- **Manual link** per session via the JIRA button on each card when auto-detection isn't what you want
- Badges open the full `https://<your-instance>/browse/<KEY>` URL in your browser

### Track Progress
- **Workflow status** — track sessions through a development lifecycle:
  `TODO` | `In Progress` | `PR Created` | `In Code Review` | `Changes Requested` | `Approved` | `Merged` | `Done` | `Abandoned`
- **Multiple branches per session** — associate one or more git branches with any session, add and remove as work evolves
- **Session metrics** — message count, code blocks, files referenced, lines added/removed, estimated duration

### Export & Preview
- **Export** sessions as Markdown or JSON
- **Open** sessions in a new editor tab with full conversation history
- **Preview** sessions in a quick-peek tab

## How It Works

```
┌──────────────────────────────┐
│   Webview Sidebar (UI)       │
│   Activity Bar Panel         │
└──────────┬───────────────────┘
           │
    Session Manager Service
           │
     ┌─────┴──────┐
     ▼            ▼
  Cursor DB    Overlay Store
  (read-only)  (JSON file)
```

**Hybrid storage** — reads session history from Cursor's internal SQLite database (`state.vscdb`) and maintains a separate overlay JSON file for your custom metadata. Your tags, pins, statuses, branches, custom names, and relationships are stored independently, so they're safe across Cursor updates.

## Commands

All commands are available via the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`):

| Command | Description |
|---------|-------------|
| `Sessions: Refresh Sessions` | Reload sessions from Cursor's database |
| `Sessions: Search Sessions` | Full-text search across all sessions |
| `Sessions: Pin Session` | Pin a session to the top |
| `Sessions: Unpin Session` | Remove pin from a session |
| `Sessions: Rename Session` | Set a custom name |
| `Sessions: Tag Session` | Add a tag |
| `Sessions: Remove Tag from Session` | Remove a tag |
| `Sessions: Add Branch to Session` | Associate a git branch |
| `Sessions: Remove Branch from Session` | Remove an associated branch |
| `Sessions: Set Session Status` | Set workflow status (TODO, In Progress, etc.) |
| `Sessions: Configure JIRA Base URL...` | Guided setup for JIRA ticket links |
| `Sessions: Set JIRA Ticket for Session` | Link a specific ticket to a session |
| `Sessions: Open Session's JIRA Ticket` | Open the linked ticket in your browser |
| `Sessions: Delete Multiple Sessions` | Pick and bulk-delete many at once |
| `Sessions: Export Session` | Export as Markdown or JSON |
| `Sessions: Link Related Sessions` | Create relationships between sessions |

## Installation

### From Marketplace
Search for "Cursor Session Manager" in the Extensions panel.

### From .vsix
```bash
cursor --install-extension cursor-session-manager-0.4.1.vsix --force
```

## Development

```bash
npm install
npm run compile   # one-time build
npm run watch     # watch mode
```

Press `F5` to launch the Extension Development Host for testing.

### Build & Package
```bash
npm run compile
npx @vscode/vsce package --no-dependencies
```

## Requirements

- Cursor IDE (or VS Code ^1.95.0)
- Sessions are read from Cursor's internal database — the extension is read-only against Cursor's data

## License

MIT
