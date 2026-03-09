# Cursor Session Manager — Full Session Notes

> Generated from the initial design & implementation session on March 3, 2026.
> This document captures all research, decisions, architecture, implementation details, and next steps so work can continue in a new window.

---

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Research Findings](#research-findings)
3. [Design Decisions](#design-decisions)
4. [Architecture](#architecture)
5. [Data Model](#data-model)
6. [What Was Built (Phase 1)](#what-was-built-phase-1)
7. [File-by-File Reference](#file-by-file-reference)
8. [Remaining Phases](#remaining-phases)
9. [Key APIs & Integration Points](#key-apis--integration-points)
10. [Known Limitations & Gaps](#known-limitations--gaps)
11. [Useful Commands](#useful-commands)
12. [External References](#external-references)

---

## Problem Statement

Cursor's built-in Agent Sessions sidebar is insufficient for heavy usage:

- **Titles are auto-truncated** — "Stop button feature implementa...", "Orchestrator-unified PR for AIS..." give almost no useful context
- **Flat chronological list** — no way to group by project, branch, ticket, or topic
- **No tagging, pinning, or bookmarking** — important sessions get buried
- **No rich search** — only basic string matching on titles, not full-text across message content
- **No session metadata visible** — can't see files touched, message count, duration, or branch
- **No relationships** — related sessions (e.g., all sessions for a feature) are scattered across time groups
- **No export or organization tools** from the UI

**Goal**: Build a VS Code extension that replaces/supplements this sidebar with rich session management.

---

## Research Findings

### How Cursor Stores Chat Data

**Primary storage**: SQLite databases (`state.vscdb`) in `workspaceStorage` directories.

| Platform | Global DB Path |
|----------|---------------|
| macOS | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` |
| Windows | `%APPDATA%\Cursor\User\globalStorage\state.vscdb` |
| Linux | `~/.config/Cursor/User/globalStorage/state.vscdb` |

Per-workspace DBs live under `<User>/workspaceStorage/<md5-hash>/state.vscdb`.

The relevant SQLite table is `ItemTable` with keys:
- `workbench.panel.aichat.view.aichat.chatdata` — main chat history
- `aiService.prompts` — stored prompts

Query:
```sql
SELECT rowid, [key], value FROM ItemTable
WHERE [key] IN ('aiService.prompts', 'workbench.panel.aichat.view.aichat.chatdata')
```

Values are JSON. The structure varies — sometimes an array, sometimes an object with `tabs` or `chats` properties. The DB reader handles all known shapes.

**Agent transcripts** are stored separately as `.jsonl` files in `.cursor/projects/.../agent-transcripts/`. Each line is a JSON object with `type`, `uuid`, `parentUuid`, `timestamp`, `sessionId`, `cwd`.

### VS Code Extension APIs Used

| API | Purpose |
|-----|---------|
| `ExtensionContext.globalStorageUri` | File-based storage for overlay JSON |
| `vscode.window.registerWebviewViewProvider` | Custom sidebar panel |
| `vscode.commands.registerCommand` | 8 commands registered |
| `vscode.window.showInputBox` | Rename, tag input |
| `vscode.window.showQuickPick` | Session selection for commands |
| `vscode.window.showSaveDialog` | Export file picker |
| `vscode.workspace.fs.writeFile` | Write exported files |

### Cursor-Specific Integration Points

**Cursor Hooks** (`hooks.json`) — session lifecycle events:
- `sessionStart` / `sessionEnd` — fires on session boundaries
- `afterAgentResponse` / `afterAgentThought` — track every response
- `preCompact` — observe context window compaction
- `subagentStart` / `subagentStop` — sub-task lifecycle
- `stop` — agent completion

Configure at `/.cursor/hooks.json` (project) or `~/.cursor/hooks.json` (global).

**Cursor MCP Extension API**:
- `vscode.cursor.mcp.registerServer()` — register MCP servers dynamically
- `vscode.cursor.mcp.unregisterServer()` — unregister by name

**Cursor Commands** (`.cursor/commands/`): Reusable workflows triggered with `/` prefix.

### Existing Community Tools Studied

| Tool | Technique | Useful For |
|------|-----------|-----------|
| SpecStory | Reads `state.vscdb` directly, saves as Markdown | Reference for DB reading |
| cursor-chat-transfer | Copies `workspaceStorage` data | Cross-device transfer |
| cursor-chat-recovery | Re-maps workspace hash after rename/move | Path recovery |
| cursor-db-mcp | SQLite queries via MCP | Query patterns |
| cursor-session (CLI) | Reads `.jsonl` transcripts | Transcript format |
| cursor-view | Python scanner for all chat dirs | Browse/search approach |

### VS Code Proposed APIs (Not Yet Stable)

The `ChatSessionController` API was proposed (Issue #268063, Oct 2025) but closed Nov 2025:
```typescript
interface ChatSessionController {
  readonly sessionType: string;
  readonly chatParticipant: ChatParticipant;
  chatSessionItemProvider?: ChatSessionItemProvider;
  newChatSessionHandler?: (request, metadata, token) => ProviderResult<ChatSessionItem>;
}
```
Not available yet. If it ships, it would allow programmatic session creation/management.

The `ChatContext.history` API only provides messages where your participant was `@`-mentioned — not the full session. Tracked in Issue #228131.

---

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| UI approach | **Both**: Webview sidebar + Chat participant (@sessions) | Sidebar for browsing/organizing, participant for conversational commands |
| Top features | Rename/tag, full-text search, group/filter, pin/bookmark, metadata, link related | User-selected priorities |
| Build scope | **Incremental** — scaffold architecture, add features one by one | Allows testing against real data early |
| Storage | **Hybrid** — read Cursor's SQLite for history, own JSON for tags/pins/metadata | Never write to Cursor's DB; overlay is our data |
| Sidebar tech | Webview (not TreeView) | Need rich UI: search bar, tag chips, filters, grouped lists |
| Overlay format | JSON file (start), migrate to SQLite if scale demands | Simple to debug, easy to start |
| Cursor DB access | Read-only, on-demand, 30s cache TTL | Safe; re-query when sidebar opens or user refreshes |
| Search | In-memory index on cached sessions | Fast enough for hundreds of sessions |
| Chat participant | Phase 5 (not MVP) | Sidebar is primary UX; participant is convenience on top |

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    UI Layer                              │
│  ┌─────────────────────┐  ┌──────────────────────────┐  │
│  │  Webview Sidebar     │  │  Chat Participant        │  │
│  │  - Session list      │  │  @sessions               │  │
│  │  - Search bar        │  │  /search /tag /pin       │  │
│  │  - Filters & groups  │  │  /related /rename        │  │
│  │  - Pin/bookmark      │  │                          │  │
│  │  - Tags & metadata   │  │                          │  │
│  └─────────┬───────────┘  └────────────┬─────────────┘  │
│            │                           │                 │
│            └───────────┬───────────────┘                 │
│                        ▼                                 │
│  ┌─────────────────────────────────────────────────┐     │
│  │         Session Manager Service                  │     │
│  │  - CRUD for overlay metadata                     │     │
│  │  - Full-text search index                        │     │
│  │  - Session grouping & relation logic             │     │
│  │  - Merge Cursor data + overlay data              │     │
│  └──────────┬──────────────────┬───────────────┘     │
│             │                  │                      │
│             ▼                  ▼                      │
│  ┌──────────────────┐  ┌─────────────────────┐       │
│  │  Cursor DB Reader │  │  Overlay Store      │       │
│  │  (read-only)      │  │  (read-write)       │       │
│  │  state.vscdb      │  │  sessions-overlay   │       │
│  │  - Chat history   │  │  .json              │       │
│  │  - Messages       │  │  - Tags, pins       │       │
│  │  - Timestamps     │  │  - Custom names     │       │
│  │  - Code blocks    │  │  - Relations        │       │
│  └──────────────────┘  └─────────────────────┘       │
└─────────────────────────────────────────────────────────┘
         ▲
         │ (Phase 6: automatic capture)
  ┌──────┴──────────┐
  │  Cursor Hooks   │
  │  sessionStart   │
  │  sessionEnd     │
  │  afterResponse  │
  └─────────────────┘
```

---

## Data Model

Defined in `src/models/types.ts`:

### Core Types

```typescript
// Raw data from Cursor's SQLite DB
interface CursorRawSession {
  id: string;
  title: string;
  messages: CursorRawMessage[];
  createdAt: number;
  lastMessageAt: number;
}

interface CursorRawMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: number;
}

// Our overlay metadata (stored in sessions-overlay.json)
interface OverlayMetadata {
  sessionId: string;
  customName?: string;
  tags: string[];
  pinned: boolean;
  groupId?: string;
  relatedSessionIds: string[];
  gitBranch?: string;
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

// Merged session (what the UI consumes)
interface Session {
  id: string;
  displayName: string;        // customName ?? autoTitle
  autoTitle: string;
  messages: CursorRawMessage[];
  createdAt: number;
  lastMessageAt: number;
  customName?: string;
  tags: string[];
  pinned: boolean;
  groupId?: string;
  relatedSessionIds: string[];
  gitBranch?: string;
  notes?: string;
  metrics: SessionMetrics;
}

interface SessionMetrics {
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  codeBlockCount: number;
  filesTouched: string[];
  estimatedDurationMs: number;
}
```

### Supporting Types

```typescript
interface SessionGroup { id: string; name: string; sessionIds: string[]; color?: string; }
interface OverlayStore { version: number; sessions: Record<string, OverlayMetadata>; groups: Record<string, SessionGroup>; }
interface SessionFilter { searchQuery?: string; tags?: string[]; pinned?: boolean; groupId?: string; dateFrom?: number; dateTo?: number; }
interface SessionListOptions { filter?: SessionFilter; sortBy?: SessionSortField; sortOrder?: SessionSortOrder; }
```

---

## What Was Built (Phase 1)

### Project Location

```
/Users/umangd03/Documents/personal/dev_personal/cursor-session-manager/
```

### Status: Compiles cleanly, git initialized, all 7 source files written.

### Registered Commands (8 total)

| Command ID | What It Does |
|-----------|-------------|
| `cursorSessions.refresh` | Force refresh session cache |
| `cursorSessions.search` | Full-text search via QuickPick |
| `cursorSessions.pinSession` | Pin a session (QuickPick selector) |
| `cursorSessions.unpinSession` | Unpin a session |
| `cursorSessions.renameSession` | Set custom name |
| `cursorSessions.tagSession` | Add a tag |
| `cursorSessions.exportSession` | Export as Markdown or JSON |
| `cursorSessions.linkSessions` | Link two sessions as related |

### Activity Bar

A "Sessions" icon is registered in the activity bar with a webview sidebar view (`cursorSessions.sidebar`).

---

## File-by-File Reference

### `src/models/types.ts`
All TypeScript interfaces. No logic. Defines Session, CursorRawSession, CursorRawMessage, OverlayMetadata, SessionMetrics, SessionGroup, SessionFilter, SessionListOptions.

### `src/services/cursorDbReader.ts`
- `getCursorDataDir()` — resolves platform-specific Cursor data directory
- `getGlobalDbPath()` — path to global `state.vscdb`
- `getWorkspaceStorageDir()` — path to `workspaceStorage/`
- `getAvailableDatabases()` — scans for all `state.vscdb` files, returns sorted by last modified
- `readSessionsFromDb(dbPath)` — opens SQLite read-only, queries `ItemTable` for chat data keys
- `readAllSessions()` — reads all DBs, deduplicates by session ID
- `parseChatData()` / `parseChatDataV1()` / `parsePromptsData()` — handles multiple JSON structures (array, object with `tabs`, object with `chats`, flat object)
- `extractSession()` — pulls id, title, messages from any recognized shape
- `extractMessages()` — normalizes role names, extracts content from various formats
- `generateTitle()` — falls back to first user message truncated to 80 chars

**Important**: Uses `better-sqlite3` with `readonly: true, fileMustExist: true`. Never writes to Cursor's DB.

### `src/services/overlayStore.ts`
- Stores data in `sessions-overlay.json` under `context.globalStorageUri`
- `ensureMetadata()` — lazy-creates overlay record for a session
- CRUD: `rename()`, `setPin()`, `addTag()`, `removeTag()`, `setGitBranch()`, `setNotes()`
- Relations: `linkSessions()`, `unlinkSessions()` — bidirectional linking
- Groups: `createGroup()`, `addToGroup()`, `removeFromGroup()`, `deleteGroup()`
- `getAllTags()` — aggregates all unique tags across sessions
- Fires `onDidChange` event for UI refresh
- `dispose()` — best-effort save on shutdown

### `src/services/sessionManager.ts`
- `getSessions(options?)` — returns merged sessions with filter/sort, pinned always on top
- `getSession(id)` — single session lookup
- `searchSessions(query)` — full-text search across displayName, tags, gitBranch, notes, AND all message content
- `getRelatedSessions(id)` — returns linked sessions
- `getGroups()` / `getSessionsByGroup(groupId)` — group queries
- `getAllTags()` — passthrough to overlay
- `refresh()` — re-reads Cursor DB + overlay, rebuilds cache
- `exportSession(id, format)` — outputs Markdown or JSON
- `computeMetrics()` — counts messages, code blocks (regex), file paths (regex), duration
- `mergeSession()` — combines CursorRawSession + OverlayMetadata into Session
- 30-second cache TTL before auto-refresh

### `src/views/sidebarProvider.ts`
- Implements `WebviewViewProvider` for the sidebar
- Full HTML/CSS/JS webview with:
  - **Search bar** with 250ms debounce
  - **Tag filter chips** — click to filter, "clear" to reset
  - **Time-grouped session list** — Pinned, Today, Yesterday, Previous 7 Days, Older
  - **Session items** showing: display name, relative time, message count, code block count, git branch, tags
  - **Pin icon** on hover (click to toggle)
  - **Hover action buttons**: Rename, Tag, Link, Export
  - **Detail view**: metrics grid, tags, files referenced, related sessions
- Uses VS Code CSS variables for native theme integration
- CSP-compliant with nonce-based script policy
- Message protocol between webview and extension for all actions

### `src/extension.ts`
- `activate()`: Creates CursorDbReader, OverlayStore, SessionManager, registers sidebar and all 8 commands
- `deactivate()`: Cleanup
- Commands use `vscode.window.showQuickPick` and `showInputBox` for native-feeling interactions
- Cleanup disposables registered properly

### `package.json`
- Extension ID: `cursor-session-manager`
- Activation: `onStartupFinished`
- Contributes: activity bar container, webview view, 8 commands
- Dependencies: `better-sqlite3` (runtime), `@types/better-sqlite3`, `@types/vscode`, `typescript` (dev)

---

## Remaining Phases

### Phase 2 — Sidebar UI Polish
- Iterate the webview against real data from your Cursor DB
- Handle edge cases in DB parsing (Cursor's format may vary by version)
- Add loading states, error handling for missing/locked DB files
- Improve the detail view with message preview/conversation replay
- Add sort controls (by date, name, message count)

### Phase 3 — Organization
- Multi-select for bulk tagging/pinning
- Tag autocomplete in the sidebar (not just input box)
- Keyboard shortcuts for common actions
- Drag-and-drop into groups
- Filter combinations (tag AND date range)

### Phase 4 — Relationships & Metadata
- Visual grouping of related sessions (collapsible sections)
- Auto-detect git branch from session context
- Show which files were actually edited (not just referenced)
- Session timeline/graph view

### Phase 5 — Chat Participant
- Register `@sessions` participant with commands:
  - `/search <query>` — full-text search
  - `/tag <session> <tag>` — add a tag
  - `/pin <session>` — pin/unpin
  - `/rename <session> <name>` — rename
  - `/related <session>` — show related sessions
  - `/list` — list recent sessions with metadata
- Use `vscode.chat.createChatParticipant` API
- Requires `chatParticipants` contribution in `package.json`

### Phase 6 — Hooks Integration
- Create `.cursor/hooks.json`:
  ```json
  {
    "version": 1,
    "hooks": {
      "sessionStart": [{ "command": ".cursor/hooks/session-start.sh" }],
      "sessionEnd": [{ "command": ".cursor/hooks/session-end.sh" }]
    }
  }
  ```
- `session-start.sh`: Capture git branch, write to a temp file
- `session-end.sh`: Read session data, compute duration, update overlay store
- Auto-tag sessions based on patterns in prompts (detect Jira ticket IDs like `AISTUDIO-\d+`)

---

## Key APIs & Integration Points

### Cursor DB Access (read-only)
```typescript
const BetterSqlite3 = require('better-sqlite3');
const db = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key);
db.close();
```

### Overlay Storage Location
```
<globalStorageUri>/sessions-overlay.json
```
On macOS this resolves to something like:
```
~/Library/Application Support/Cursor/User/globalStorage/<extension-id>/sessions-overlay.json
```

### Webview ↔ Extension Communication
```typescript
// Extension → Webview
this.view.webview.postMessage({ type: 'sessions', sessions, tags, groups });

// Webview → Extension
webviewView.webview.onDidReceiveMessage(async (msg) => {
  switch (msg.type) {
    case 'search': ...
    case 'pin': ...
    case 'rename': ...
  }
});
```

### Cursor Hooks JSON Schema
```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [{ "command": "path/to/script.sh", "timeout": 30 }],
    "sessionEnd": [{ "command": "path/to/script.sh" }],
    "afterAgentResponse": [{ "command": "path/to/script.sh" }]
  }
}
```

Hooks receive JSON via stdin, return JSON via stdout. Exit code 0 = success, 2 = block action.

---

## Known Limitations & Gaps

1. **Cursor's chat data JSON format is undocumented and varies** — the DB reader handles multiple shapes (array, `tabs`, `chats`, flat) but may need updates as Cursor evolves.

2. **`better-sqlite3` is a native module** — requires rebuild for each platform. May cause issues in some environments. If problematic, can switch to `sql.js` (pure WASM).

3. **No public Cursor API for chat sessions** — we read the SQLite DB directly. This is fragile if Cursor changes its storage format.

4. **Chat participant API (`ChatContext.history`) is participant-scoped** — can only see messages where `@sessions` was mentioned, not the full conversation.

5. **The DB may be locked** — if Cursor is actively writing to `state.vscdb`, reads could fail or return stale data. The reader opens in `readonly` mode which should be safe, but watch for `SQLITE_BUSY`.

6. **Agent transcripts (`.jsonl`) are not yet integrated** — Phase 1 only reads from `state.vscdb`. The `.jsonl` transcripts in `agent-transcripts/` contain richer data and should be a future data source.

7. **No cross-device sync yet** — overlay data lives locally. Phase 6+ could add git-based or cloud sync.

---

## Useful Commands

```bash
# Navigate to project
cd /Users/umangd03/Documents/personal/dev_personal/cursor-session-manager

# Install dependencies
npm install

# Compile
npm run compile

# Watch mode (auto-recompile on save)
npm run watch

# Test in Cursor (press F5 in the project, or run):
# This opens an Extension Development Host window

# Check Cursor's DB directly
sqlite3 ~/Library/Application\ Support/Cursor/User/globalStorage/state.vscdb \
  "SELECT key FROM ItemTable WHERE key LIKE '%chat%' OR key LIKE '%aichat%';"

# List workspace storage databases
ls -lt ~/Library/Application\ Support/Cursor/User/workspaceStorage/*/state.vscdb | head -10
```

---

## External References

| Resource | URL |
|----------|-----|
| VS Code Chat Participant API | https://code.visualstudio.com/api/extension-guides/chat |
| VS Code Extension State APIs | https://code.visualstudio.com/api/extension-capabilities/common-capabilities |
| Cursor Hooks Docs | https://cursor.com/docs/agent/hooks |
| Cursor MCP Extension API | https://cursor.com/docs/context/mcp-extension-api |
| VS Code Chat Session API Proposal | https://github.com/microsoft/vscode/issues/268063 |
| ChatContext history limitation | https://github.com/microsoft/vscode/issues/228131 |
| SpecStory Extension | https://get.specstory.com/cursor-extension |
| cursor-db-mcp | https://github.com/jbdamask/cursor-db-mcp |
| cursor-session CLI | https://github.com/iksnae/cursor-session |
| @vscode/chat-extension-utils | https://www.npmjs.com/package/@vscode/chat-extension-utils |
| Cursor Agent Session Resumption Request | https://github.com/cursor/cursor/issues/3846 |
| Cursor Chat Persistence (Containers) | https://forum.cursor.com/t/cursor-chat-persistence-across-container-sessions/147731 |
