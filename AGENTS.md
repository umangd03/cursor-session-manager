# Agent Instructions for Cursor Session Manager

## Project Overview

This is a VS Code / Cursor extension that enhances agent chat session management. It provides a sidebar panel for searching, tagging, pinning, tracking status, and organizing sessions.

- **Language:** TypeScript
- **Extension entry:** `src/extension.ts`
- **UI:** Webview sidebar in `src/views/sidebarProvider.ts`
- **Data layer:** `src/services/overlayStore.ts` (custom metadata), `src/services/cursorDbReader.ts` (Cursor DB reader)
- **Models:** `src/models/types.ts`

## Build & Install

```bash
npm run compile
npx @vscode/vsce package --no-dependencies
cursor --install-extension cursor-session-manager-<version>.vsix --force
```

## Publishing

When the user asks to publish, build, release, or deploy the extension, follow these steps **in order**:

### 1. Bump version

Increment the `"version"` field in `package.json` (semver: patch for fixes, minor for features, major for breaking changes).

### 2. Compile and package

```bash
npm run compile
npx @vscode/vsce package --no-dependencies
```

Verify the build succeeds with exit code 0 and note the output `.vsix` filename.

### 3. Install locally into Cursor

```bash
cursor --install-extension cursor-session-manager-<version>.vsix --force
```

### 4. Publish to VS Code Marketplace

The VS Code Marketplace does not have CLI auth configured. Inform the user to upload the `.vsix` manually:

- Go to https://marketplace.visualstudio.com/manage
- Click `...` next to "Cursor Session Manager" > **Update**
- Upload the `.vsix` file

### 5. Publish to Open VSX Registry

Load the token from `.env` and publish:

```bash
source .env && npx ovsx publish cursor-session-manager-<version>.vsix -p $OVSX_PAT
```

The namespace `umangdesai` is already created. This publishes to https://open-vsx.org/extension/umangdesai/cursor-session-manager.

### 6. Confirm to the user

After publishing, tell the user:
- The local install is done (reload Cursor to activate)
- Open VSX publish succeeded (or failed with error)
- VS Code Marketplace needs manual upload with the `.vsix` path

## Important Notes

- Never hardcode the Open VSX token in commands or source files. Always read from `.env`.
- The `.env` file is gitignored and must never be committed.
- Always run `npm run compile` first to catch TypeScript errors before packaging.
- The `README.md` is the marketplace landing page -- keep it updated when adding features.
