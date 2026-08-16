# 输入框文件引用插件 · Input File Reference

<div align="center">
  <a href="README.md">中文</a> · <b>English</b>
</div>

> **Type `@` in the composer to list files under the session's working directory (like Claude Code / Cursor), pick one, and the model can read it.**
> Adds a **"file"** `@` reference source to the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI input, coexisting with the built-in skill / subagent references **in the same menu**.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## 1. What problem it solves

The dsh input already has an `@` trigger pipeline (`dsh-client-ui-input-trigger`), but only two reference sources: skills and subagents. There was no way to reference a file in the working directory.

This plugin adds a **file reference source**, with the data provided by the host half:

```
dsh-input-file-ref (node half, lib/index.js — zero external deps, Node builtins only)
  GET /api/input-file-list?sessionId=…&query=…
    ├─ locates the session log ($DSH_HOME/sessions directory tree)
    ├─ reads the log's first `session` record → the session's cwd (never a client-supplied path)
    └─ recursively lists files under cwd (relative path + size), skipping .git/node_modules etc.
          │
          ▼  (browser fetch, same-origin)
  '@' file source (client half) ── type @ → file menu (searchable, keyboard / mouse)
    pick → draft chip (@src/main.ts) ──send──► model sees <file>src/main.ts</file> and reads it with fs
```

**Read-only**: this plugin modifies no files. The host half only **reads** session-log headers and filesystem metadata (path/size/mtime) — it never reads, writes, or deletes any file contents.

## 2. Features

- ✅ Type `@` to list files under the current session's working directory (recursive, relative path + size).
- ✅ Type to filter: case-insensitive substring match, **basename matches sorted first**.
- ✅ Both keyboard (↑/↓/Enter/Esc) and mouse selection, consistent with the `/` command menu.
- ✅ Picked files appear as chips (`@src/main.ts`); deleted as a whole.
- ✅ On send the model receives `<file>relative/path</file>` and reads it with its own fs tool (sandbox rooted at the session cwd).
- ✅ Sessions without a working directory show a hint in the `@` menu instead of crashing.
- ✅ Coexists with the existing `@` skill / subagent references, shown as separate groups.
- ✅ Bilingual (Chinese/English) UI text, follows the interface language.
- ✅ Read-only, zero external dependencies, and a browser-trust fence (blocks DNS rebinding / cross-site).

**MVP not included**: content is not inlined into messages; no file preview / syntax highlighting; no multi-select batches.

## 3. Directory layout

```
dsh-input-file-ref/           # repo root = npm package root
├── package.json              # dsh.bundle.patch + dsh.client (browser declaration) + exports["./client"]
├── cordis.patch.yml          # composition row: inject webRuntime + trustedHosts config
├── LICENSE                   # MIT
├── .gitignore
└── lib/
    ├── index.js              # host half: /api/input-file-list route + cwd resolution + recursive listing (zero deps)
    └── client.js             # browser bundle: registers the '@' file reference source (insert + codec path)
```

## 4. Quick start

One-click install (GitHub):

```powershell
dsh plugin --profile web add github:AFAP/dsh-input-file-ref
```

Then **restart `dsh web`** to activate.

> After install the plugin lives at `$DSH_HOME\profiles\web\node_modules\dsh-input-file-ref` (pnpm clones it from GitHub), independent of the source repo location.

Update:

```powershell
dsh plugin --profile web update dsh-input-file-ref
```

Uninstall:

```powershell
dsh plugin --profile web remove dsh-input-file-ref
```

### Manual install from a source directory (equivalent, for verification)

```powershell
dsh plugin --profile web add "D:\path\to\dsh-input-file-ref"
```

### Verify it loaded

Create or open a session that already has a working directory → type `@` in the input → a "file" group with the file list appears.

## 5. Usage

1. **Pick a working directory**: the session must have a cwd.
2. Type `@` in the input → a file picker opens (with a "file" group). Keep typing to filter by path.
3. Use ↑/↓ + Enter (or click) to select a file → a chip appears in the draft (`@src/main.ts`).
4. On send the reference travels as `<file>src/main.ts</file>`; the model reads it with its fs tool.
5. To remove, select the chip and press Backspace/Delete to drop it as a whole.

For a session without a working directory, typing `@` shows a "no working directory" hint instead of crashing.

## 6. API quick reference

```
GET /api/input-file-list?sessionId=<sessionId>[&query=<substring>]
```

- Requires the browser-trust fence to pass (loopback / `trustedHosts` + same-origin), otherwise `403`.
- An invalid/unknown `sessionId` returns `404` (an error, never arbitrary path content).
- A missing `sessionId` returns `400`.

Response example (session with a working directory):

```json
{
  "cwd": "D:/workspace/MyProject",
  "noCwd": false,
  "truncated": true,
  "files": [
    { "path": "src/main.ts", "size": 2384, "mtime": 1719300000000 },
    { "path": "README.md", "size": 512, "mtime": 1719200000000 }
  ]
}
```

Session without a working directory:

```json
{ "noCwd": true, "files": [] }
```

## 7. Configuration

| Key | Default | Description |
|---|---|---|
| `trustedHosts` | from `webRuntime` (loopback + LAN + `--trusted-host`) | Non-loopback authorities the browser-trust fence trusts. |
| `ignore` | `.git`, `node_modules`, `.venv`, etc. (below) | Directory basenames skipped during the walk. Defaults: `.git`, `node_modules`, `.venv`, `venv`, `__pycache__`, `.next`, `.nuxt`, `dist`, `build`, `.idea`, `.vscode`, `.DS_Store`. |

> `ignore` can be overridden at the composition layer by appending to the `config` of `cordis.patch.yml` (the defaults are already built in; usually no change is needed).

## 8. Logs & troubleshooting

| Symptom | Where to look |
|---|---|
| Typing `@` does nothing / no "file" group | Confirm `dsh web` was restarted and the plugin is installed; check that skill/subagent are still listed (coexistence is normal). |
| "file" group stuck at "Listing…" | Open devtools Network and check the `/api/input-file-list` status: `403` = trust fence, `404` = session not found. |
| Hint "no working directory" | The session has no cwd; pick a working directory first. |
| "Too many results" | File count exceeds the cap (500 by default); keep typing to filter. |

## 9. Security & compliance (please read)

- **Read-only**: this plugin modifies/deletes nothing; the host only reads session-log headers and filesystem metadata, never file contents.
- **Path red line**: the cwd is resolved **only** from the session's persisted header (the absolute path recorded at session creation), **never** from a client-supplied path; the `sessionId` is single-segment-escaped before any path use, preventing directory traversal.
- **Browser-trust fence**: `/api/input-file-list` only accepts loopback or declared `trustedHosts` same-origin requests; it rejects `sec-fetch-site: cross-site` and differing-Origin requests to block DNS rebinding and cross-site calls.
- **Minimal information**: only relative paths, file names, sizes, and mtimes are returned — never absolute paths, never file contents.
- **Local sessions only**: the file list only serves local session logs; it does not expose an arbitrary directory browser.
- **No private data in the repo**: no secrets, no local absolute paths (documentation uses placeholders like `<your-project>`).

## 10. FAQ

- **Q: Does the plugin read file contents?** A: No. The host only lists metadata; the model reads contents with **its own fs tool** once it receives the `<file>…</file>` reference (sandbox rooted at the session cwd).
- **Q: Can I reference multiple files?** A: Yes — insert several `@` file chips; each is serialized to `<file>…</file>` on send.
- **Q: Why does the group header show "file" instead of "Files"?** A: The `@` menu group titles come from the built-in `slash.menu` dictionary (single-owner namespace; third parties cannot add keys), so the localized group name cannot be injected. All plugin-owned hints/errors are bilingual.

## 11. Development & build

Pure JS, no build step (no GitHub Actions workflow needed). Layering:

- `lib/index.js`: host half, **zero external deps** (Node builtins only), so it loads correctly no matter how it is installed (git / registry / file: / link:).
- `lib/client.js`: browser bundle (classic script via `window.__ModuleLoader__.load`) that only registers one `@` reference source — no UI components.

## 12. Related docs

- Input reference contract: `@deepseek-ai/dsh-client-ui-input-trigger/lib/types/types.d.ts`
- References: the `/` skill source `@deepseek-ai/dsh-client-ui-skill`, the `@` subagent source `@deepseek-ai/dsh-client-ui-subagent`, and the exact-route example [dsh-token-usage](https://github.com/AFAP/dsh-token-usage).

## 13. License

MIT © AFAP
