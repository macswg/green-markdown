# Green Markdown — Plan

A lightweight, Typora-style desktop app for viewing and editing `.md` files,
mainly on macOS but also running on Windows and Linux. All styling and editor
behavior lives in plain files that Claude Code can edit, and the app picks up
changes instantly.

Status: **Phase 1 built** (2026-09-13). Decisions are in §10 and implementation notes in §11.

---

## 1. Goals / non-goals

**Goals**
- Opens fast, uses little memory, and ships as a small app (not a 150 MB Electron bundle).
- **Always editable**, like Typora. The rendered document is the editor, with no
  separate read mode.
- One file per window.
- Works with the normal file workflow: double-click a `.md` in Finder, `gmd file.md`
  from a terminal, drag and drop, and recent files.
- **Live reload when a file changes on disk.** If Claude edits a file you have
  open, the view updates.
- **Claude-adjustable formatting.** Theme, typography and editor behavior live
  in files **inside this repo**, so they're version-controlled and consistent
  across machines. The app hot-reloads them.
- Leaves your files alone. Opening and closing a file never rewrites it, and
  saving an edit changes as little of the source as possible (these files live in git).

**Non-goals (for now)**
- Folder mode, file tree, quick-open.
- Math (KaTeX) and Mermaid. Both are turned off to keep the bundle small; they
  can come back later.
- Sync, accounts, collaboration, plugins, hosted or Docker deployment.

---

## 2. Platform: Tauri v2

| Option | Size / RAM | Opens local files well | Cross-platform | Verdict |
|---|---|---|---|---|
| **Tauri v2** (Rust shell + system webview) | ~10 MB app, ~60–100 MB RAM | Yes | mac / win / linux | **Chosen** |
| Electron | ~150 MB app, 200 MB+ RAM | Yes | mac / win / linux | Fallback only |
| Local web server / Docker | Tiny | Poor: no double-click-to-open, clumsy save | Anywhere | Rejected |

Tauri uses the system webview: WebKit on mac, WebView2 on Windows, WebKitGTK on
Linux. It needs the Rust toolchain (`brew install rustup && rustup default stable`).

---

## 3. Editor engine: Milkdown / Crepe (Option A)

- WYSIWYG editing that feels like Typora: headings, lists, tables, task lists,
  code blocks, images, slash menu.
- Markdown is re-serialized on save, which can normalize formatting. Mitigations:
  - **Never write unless you actually edited.** The dirty flag is based on user
    edits, not on the editor's internal state.
  - Serializer preferences (bullet char, emphasis char, etc.) live in `settings.json`.
  - A **Source mode** toggle (CodeMirror, Phase 2) for byte-exact editing.
  - Round-trip tests (§8).
- Crepe features not in scope (LaTeX) are disabled.

---

## 4. Config: in this repo, editable by Claude

The config lives in the repo so it's the same on every machine:

```
config/
├── settings.json              # editor + app behavior (schema-validated)
└── theme.css                  # active theme — CSS variables + overrides
```

**How the app finds it**, in order:
1. The `GMD_CONFIG_DIR` environment variable, if set. Useful for dev and testing.
   GUI launches from Finder don't see shell env vars, so this is only a fallback.
2. **The repo's `config/` directory, recorded at build time.** The app is built
   locally on each machine from its clone of the repo, so the built app
   automatically points at that clone's `config/`. No setup is needed.
3. Built-in defaults compiled into the app. These are used if the directory is
   missing, for example on a CI-built binary on a machine without the repo.
   A banner says so.

Details:
- The app **watches `config/` and hot-reloads**. When Claude edits `theme.css`,
  the open window restyles within a second.
- `theme.css` is built on **CSS variables**, so most tweaks are one line:
  `--gmd-content-width`, `--gmd-font-body`, `--gmd-font-size`, `--gmd-h1-size`…,
  `--gmd-link-color`, `--gmd-code-bg`, `--gmd-syntax-*`, and separate light/dark
  palettes (full list in the `md-style` skill).
  For anything else, full CSS overrides are allowed.
- `settings.json` (the actual keys; `settings.schema.json` is the source of truth):
  ```json
  {
    "theme": "theme.css",
    "appearance": "system",
    "editor": {
      "spellcheck": true,
      "bulletChar": "auto",
      "hardBreak": "auto",
      "blockHandle": true,
      "selectionToolbar": true,
      "placeholder": "Start writing…"
    }
  }
  ```
  `settings.schema.json` provides validation. Bad values show a non-blocking
  banner and fall back to defaults.
- **Claude skill** at `.claude/skills/md-style/SKILL.md` documents every variable
  and setting, with recipes like "make headings serif" or "narrower column".
  To use it from any Claude session, not just inside this repo, symlink it into
  `~/.claude/skills/`. The README covers this.
- Editing config means editing files in git. Commit them like any other change,
  and `git pull` on another machine gives the same look.

---

## 5. Feature scope by phase

### Phase 1: Core app (view + edit)
- Tauri v2 + Vite + TypeScript scaffold (vanilla TS).
- Milkdown/Crepe editor, always editable. Renders GFM: tables, task lists,
  strikethrough, autolinks, footnotes, highlighted code blocks.
- Relative images resolve against the file's folder.
- Open a file from the CLI arg, ⌘O dialog, drag and drop, or macOS Finder /
  "Open With" (file associations for `.md`, `.markdown`).
- One file per window. Opening another file opens a new window in the same app
  instance.
- ⌘S save (atomic write), dirty indicator in the title, and a confirm prompt when
  closing with unsaved changes.
- Live reload when the file changes on disk. A clean document reloads silently.
  If you have unsaved edits, a banner offers **Reload from disk / Keep mine**.
- Repo `config/` with `settings.json` + `theme.css`, hot reload, light/dark mode
  following the system.
- `md-style` skill.
- External links open in the browser. Links to relative `.md` files open in a
  new window.
- Window size and position are remembered.

### Phase 2: Editing polish
- ✅ Source mode toggle (⌘/) using CodeMirror 6.
- ✅ Outline/TOC sidebar (⇧⌘O), find (⌘F).
- Paste an image, save it to `./assets/` next to the file, and insert a relative link.
- Show a diff in the conflict banner. Optional autosave. Recent-files menu.
- Round-trip fixture tests expanded with real files from this repo.

### Phase 3: Later, if wanted
- Export to HTML / PDF, focus mode, word count.
- `gmd` CLI shim on PATH.
- Math / Mermaid (lazy-loaded).
- GitHub Actions builds for Windows / Linux.

---

## 6. Architecture

```
┌──────────────── Tauri window (system webview) ────────────────┐
│  Frontend (TS)                                                 │
│   ├─ main.ts         window bootstrap, keybindings, banners    │
│   ├─ editor/         Milkdown Crepe wrapper, dirty tracking    │
│   ├─ config/         load + validate settings, apply theme CSS │
│   └─ styles/         base.css (layout)                         │
└──────────────────────────────┬─────────────────────────────────┘
                               │ Tauri IPC commands / events
┌──────────────────────────────┴─────────────────────────────────┐
│  Rust core (src-tauri) — deliberately thin                     │
│   ├─ read_file / write_file (atomic: tmp + rename)             │
│   ├─ watcher: open doc + config dir → change events            │
│   ├─ config dir resolution (env → build-time repo path → none) │
│   ├─ window-per-file; CLI args + macOS Opened event            │
│   └─ plugins: dialog, single-instance, window-state, opener    │
└────────────────────────────────────────────────────────────────┘
```

### Layout
```
green-markdown/
├── README.md
├── PLAN.md
├── package.json / vite.config.ts / tsconfig.json
├── index.html
├── src/                      # frontend
├── src-tauri/                # Rust shell, tauri.conf.json
├── config/                   # ← the live config Claude edits (settings.json, theme.css)
├── settings.schema.json
├── tests/
└── .claude/skills/md-style/SKILL.md
```

This project is TypeScript and Rust rather than the repo's usual Python, so it
follows Prettier and `cargo fmt` conventions. It's listed under
**Document & media tooling** in the root `README.md`.

---

## 7. Build and distribution

- **Dev:** `npm run tauri dev`.
- **Mac:** `npm run tauri build` produces a `.app` / `.dmg`, unsigned. A locally
  built app isn't quarantined. Set it as the default for `.md` via Finder →
  Get Info → Open with → Change All.
- **Windows / Linux:** build on those machines with the same command. This also
  records that machine's repo `config/` path. CI builds are deferred.

---

## 8. Testing

- **Round-trip (Vitest):** `.md` fixtures are parsed and serialized, and the
  output is compared with the input, byte-exact or within an allow-list of
  accepted normalizations.
- **Settings:** schema validation, bad JSON falls back gracefully, and merge with defaults works.
- **Rust:** atomic write, config dir resolution.
- **Manual smoke checklist:** open via Finder, edit, save, external change, theme hot-reload.

---

## 9. Risks

- **Markdown normalization on save.** Mitigated by the no-write-unless-edited
  rule, serializer settings, round-trip tests and Source mode (Phase 2).
- **Webview differences on Linux (WebKitGTK).** Acceptable as a secondary platform.
- **Typora parity is a long tail.** The goal is "better for my workflow", not parity.

---

## 10. Decisions (2026-09-13)

1. Editor: **Option A**, Milkdown/Crepe WYSIWYG.
2. Default mode: **always editable**.
3. Windows: **one file per window**. No folder mode.
4. Math/Mermaid: **not now**.
5. Config: **in this repo** (`config/`), found through a path recorded at build time.
6. Name: **`green_markdown_viewer`**, CLI **`gmd`**.

---

## 11. Implementation notes (Phase 1)

What changed from the plan, and why:

- **Minimal-diff saving (`src/preserve.ts`).** A test run on all 69 `.md`
  files in this repo showed that saving the editor's raw output would have
  changed 58 of them, even without edits: `_` and `~` escaping, `<>` around
  bare URLs, table re-padding, and extra blank lines. Serializer settings alone
  couldn't fix that. Saving now compares the serialized original with the
  serialized edit and writes the original bytes for every unchanged line. The
  merged result must re-parse to the same document as the editor's output, or
  the full serializer output is written instead. After an edit, all 69 repo
  files saved with only the edited lines changed.
- **Style auto-detection.** Bullet marker, thematic break, and hard-break style
  are detected from each file. `bulletChar` and `hardBreak` settings default to
  `auto`.
- **No Crepe image-block feature.** It overwrote image alt text with a size
  ratio on save (`![alt]` became `![1.00]`). Plain markdown images use a custom
  node view that loads relative paths through Tauri's asset protocol.
- **Front matter** is split off before the editor sees it and shown as an
  editable raw block. Otherwise the editor would turn `---` into a rule and
  corrupt it.
- **Syntax highlighting** colors come from `--gmd-syntax-*` CSS variables, so
  code-block colors are themeable too.
- **No `themes/` folder.** A second theme file would have to duplicate every
  variable. Git history covers theme versions.
- **No window-state plugin.** Windows are labeled per document, so the last
  window's size and position are saved in the app config dir, and new windows
  cascade from it.
- **Dev logging:** `tauri dev` prints webview errors and lifecycle events to
  the terminal through a `dev_log` command. Release builds skip it.

Verification: `npm test` (48 vitest tests), `cargo test` (8 tests), a manual
run of the dev app (open, external change reload, config hot-reload with an
invalid setting, second-instance file handoff), and a headless-browser run of
type → save → watcher echo → conflict banner → reload.
