# green_markdown_viewer — Green Markdown (`gmd`)

A lightweight, Typora-style markdown editor. It opens `.md` files as clean,
always-editable documents, one file per window. Theme and behavior live in plain
files in this repo that Claude can edit, and open windows restyle as soon as
those files are saved.

- **Small:** Tauri v2 shell using the system webview, not a bundled browser.
- **Leaves your files alone:** opening a file never writes it. Saving rewrites
  only the lines you edited; everything else keeps its original bytes (see
  [Saving](#saving)).
- **Live:** when a file changes on disk (Claude, git, another editor), it
  reloads. If you have unsaved edits, a banner asks what to do.
- **Cross-platform:** macOS first; Windows and Linux build from the same source.

See [PLAN.md](PLAN.md) for the design and roadmap.

## Setup

Prerequisites: Node 20+, Rust (`brew install rustup && rustup default stable`),
and Xcode Command Line Tools on macOS. On Linux, also install the
[Tauri system packages](https://tauri.app/start/prerequisites/). On Windows,
WebView2 is already present on Windows 10/11.

```bash
cd green_markdown_viewer
npm install
npm run tauri dev -- -- /path/to/file.md   # dev window with hot reload
npm run tauri build                         # release app in src-tauri/target/release/bundle/
```

On macOS the build produces `Green Markdown.app` (plus a `.dmg`). Copy it to
`/Applications`, then set it as the default for markdown files: Finder → select
any `.md` → Get Info → Open with → Green Markdown → Change All. The app isn't
signed, but a build made on your own Mac opens normally.

Build on each machine you use it on. The build records that checkout's
`config/` path, so every machine uses the repo's config (sync it with git).

## Using it

| Action | How |
|--------|-----|
| Open | Double-click in Finder/Explorer, ⌘O, drag files onto a window, or run the binary with paths |
| New / Save / Save As / Close | ⌘N / ⌘S / ⇧⌘S / ⌘W (Ctrl on Windows/Linux) |
| Follow a link | ⌘-click (Ctrl-click). Relative `.md` links open in a new window |
| Block menu | Type `/` on an empty line, or use the `+`/drag handle at the left |
| Front matter | YAML/TOML front matter appears as a collapsible raw block at the top |
| Config folder | App menu (macOS) / File menu → Open Config Folder |

Opening a file that's already open focuses its window. Opening from an
untouched Untitled window loads the file into that window.

## Configuration (Claude-editable)

```
config/
├── settings.json   # behavior, validated against settings.json schema
└── theme.css       # all visuals as --gmd-* CSS variables (light + dark)
```

Both files are watched and hot-reloaded. Ask Claude things like "make headings
serif" or "narrower column, bigger text". The
[`md-style` skill](.claude/skills/md-style/SKILL.md) documents every variable
and setting. To use the skill from any Claude session, not just inside this
repo:

```bash
ln -s "$PWD/.claude/skills/md-style" ~/.claude/skills/md-style
```

Config lookup order: `$GMD_CONFIG_DIR`, then the repo `config/` recorded at
build time, then built-in defaults (with a banner).

## Saving

The editor (Milkdown/Crepe) works on a document model and re-serializes
markdown, which would normally normalize formatting across the whole file
(`snake_case` becomes `snake\_case`, tables get re-padded, blank lines shift).
To prevent that, `src/preserve.ts` diffs the serialized original against the
serialized edit and writes original bytes for every unchanged line. The merged
text is then parsed again and must produce the same document as the editor's
output. If it doesn't (for example, a file that mixes bullet markers inside one
list), the full serializer output is written instead.

Also preserved exactly: front matter, BOM, CRLF line endings, and trailing
newlines. `editor.bulletChar` and `editor.hardBreak` default to `auto`, which
matches the file's existing style for edited content.

## Development

```bash
npm test                                         # vitest: helpers, settings, round-trip/minimal-diff
cargo test --manifest-path src-tauri/Cargo.toml  # atomic writes, watcher, config resolution
npx tsc --noEmit                                 # type-check
npm run format                                   # prettier + cargo fmt
```

In `tauri dev`, webview errors and lifecycle events (`showing …`, `saved …`,
`config reloaded`) are printed to the terminal.

Layout:

```
src/            frontend (TypeScript, no framework)
  main.ts       window controller: load, save, conflicts, links, events
  editor.ts     Crepe setup, serializer options, bodyToSave
  preserve.ts   minimal-diff merge
  markdown.ts   front matter/EOL splitting, style detection, path resolution
  settings.ts   settings.json validation
  theme.ts      config loading, theme + appearance application
  styles/       layout + mapping of --gmd-* vars onto the editor
src-tauri/      Rust shell: windows, menus, file I/O, watchers, single instance
config/         live settings + theme (edited by you/Claude)
tests/          vitest suites and markdown fixtures
```

## Known limitations (Phase 1)

- Raw HTML blocks show as source text instead of rendering.
- Pasting or dropping image files is ignored (Phase 2: save into `./assets/`).
  Existing images, relative or absolute, display normally.
- No source mode, outline, or find yet (Phase 2).
- On Windows, the file-drop handler disables dragging blocks by their handle.
- Math and Mermaid are intentionally off.
