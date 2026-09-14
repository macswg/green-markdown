---
name: md-style
description: Change how Green Markdown (the gmd markdown editor app) looks or behaves — fonts, sizes, colors, content width, heading/code/table/quote styling, light/dark mode, syntax highlighting colors, spellcheck, bullet and line-break style on save, block handle and toolbar. Use when the user asks to restyle, theme, or tweak their markdown viewer/editor.
---

# Styling Green Markdown

Green Markdown reads two files from its **config folder** and **hot-reloads
them in every open window** within about a second of saving. Editing them is the
whole job; there is no rebuild or restart.

| File | Controls |
|------|----------|
| `theme.css` | Everything visual: CSS variables + optional override rules |
| `settings.json` | Behavior: appearance mode, editor options, which theme file |

### Which config folder is live

The app uses the first of these that exists:

1. `$GMD_CONFIG_DIR` (rare; GUI launches don't see shell variables).
2. The repo `config/` path recorded at build time — only for apps **built
   locally** from a checkout (`npm run tauri build` / `tauri dev`).
3. **The per-user folder** — what installed releases use:
   - macOS: `~/Library/Application Support/Green Markdown/config/`
   - Windows: `%APPDATA%\Green Markdown\config\`
   - Linux: `~/.config/Green Markdown/config/`

**Default to the per-user folder** when the user has an installed release (the
normal case). Edit the repo `config/` only when they're running a local/dev
build, or when they ask to change the defaults shipped to new installs. The
two copies don't sync; say which one you changed. If unsure, check whether
`/Applications/Green Markdown.app` exists and that the per-user folder does.
The app's menu has **Open Config Folder**, which opens whichever is live.

## Workflow

1. Read the current `theme.css` in the live folder (and `settings.json` if behavior is
   involved) — never overwrite blind; the user may have customized it.
2. Prefer changing an existing `--gmd-*` variable over adding rules.
3. Colors: change **both** the light block (`:root`) and the dark block
   (`:root[data-appearance="dark"]`) unless the user asked for only one mode.
4. For anything variables don't cover, append rules in the "Custom overrides"
   section at the bottom, prefixed with `.milkdown .ProseMirror` (document
   content) or `.milkdown .milkdown-code-block` / `.milkdown .milkdown-table-block`
   so they beat the editor's built-in styles.
5. For settings, only use keys listed below; unknown keys or bad values show a
   warning banner in the app and fall back to defaults. `settings.schema.json`
   is the source of truth and validates in editors.
6. These files are in git — mention that the user can commit to sync the look
   across machines.

## Theme variables (`theme.css`)

Typography
- `--gmd-font-body`, `--gmd-font-heading`, `--gmd-font-mono` — font stacks. Only
  use fonts installed on the system (no web font loading); always end with a
  generic family (`serif`, `sans-serif`, `monospace`).
- `--gmd-font-size` (base, e.g. `16px`), `--gmd-line-height` (unitless, e.g. `1.7`)
- `--gmd-code-font-size` (relative, e.g. `0.875em`), `--gmd-paragraph-spacing`
- `--gmd-source-font-size` (source mode text, e.g. `14px`)

Layout
- `--gmd-content-width` (text column max width, e.g. `740px`)
- `--gmd-page-padding-x`, `--gmd-page-padding-top`, `--gmd-page-padding-bottom`
- `--gmd-radius` (code blocks, images)
- `--gmd-outline-width` (outline sidebar, e.g. `240px`)
- `--gmd-handle-size` (block `+`/drag icons, e.g. `16px`), `--gmd-handle-opacity`
  (resting opacity, full on hover)

Headings
- `--gmd-h1-size` … `--gmd-h6-size`, `--gmd-heading-weight`,
  `--gmd-heading-line-height`, `--gmd-heading-spacing-top`,
  `--gmd-heading-spacing-bottom`
- `--gmd-h1-border`, `--gmd-h2-border` — e.g. `1px solid var(--gmd-border)` for
  GitHub-style underlines, `none` to remove

Text details
- `--gmd-link-decoration` (`underline` / `none`), `--gmd-blockquote-style`
  (`normal` / `italic`)

Colors (define in both light and dark blocks)
- Page: `--gmd-bg`, `--gmd-text`, `--gmd-text-muted`, `--gmd-heading-color`
- Accent: `--gmd-accent` (checkboxes, focus, menus), `--gmd-accent-soft` (banner,
  highlights), `--gmd-link-color`, `--gmd-selection`
- UI surfaces: `--gmd-border`, `--gmd-surface`, `--gmd-surface-low`, `--gmd-hover`
- Code: `--gmd-code-bg` (inline), `--gmd-code-block-bg`, `--gmd-code-text`,
  `--gmd-inline-code-color`
- Blocks: `--gmd-blockquote-border`, `--gmd-blockquote-text`,
  `--gmd-table-border`, `--gmd-table-header-bg`, `--gmd-table-stripe`,
  `--gmd-hr-color`
- Find: `--gmd-find-match`, `--gmd-find-current`
- Syntax highlighting: `--gmd-syntax-keyword`, `-string`, `-number`, `-comment`,
  `-function`, `-type`, `-property`, `-tag`, `-punctuation`, `-invalid`

## Settings (`settings.json`)

| Key | Values | Meaning |
|-----|--------|---------|
| `theme` | path inside the config folder, default `"theme.css"` | Which CSS file is the theme |
| `appearance` | `"system"` / `"light"` / `"dark"` | Color mode |
| `editor.spellcheck` | `true` / `false` | Spellcheck underlines |
| `editor.bulletChar` | `"auto"` / `"-"` / `"*"` / `"+"` | Bullet marker for edited lists; `auto` matches the file |
| `editor.hardBreak` | `"auto"` / `"spaces"` / `"backslash"` | How line breaks are written; `auto` matches the file |
| `editor.blockHandle` | `true` / `false` | Drag handle beside blocks and the `/` menu |
| `editor.selectionToolbar` | `true` / `false` | Formatting toolbar on text selection |
| `editor.placeholder` | string | Hint text in empty documents |

Changing `editor.*` rebuilds the open editor (unsaved text is kept, undo history
is reset). Saving only rewrites the lines the user edited, so `bulletChar` and
`hardBreak` affect edited content only.

## Recipes

Serif reading style:
```css
--gmd-font-body: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
--gmd-font-heading: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
--gmd-font-size: 17px;
--gmd-line-height: 1.75;
```

GitHub-like headings:
```css
--gmd-heading-weight: 600;
--gmd-h1-border: 1px solid var(--gmd-border);
--gmd-h2-border: 1px solid var(--gmd-border);
```

Wider column, tighter text: `--gmd-content-width: 920px; --gmd-line-height: 1.55;`

Custom rule example (bottom of theme.css):
```css
.milkdown .ProseMirror h1 { letter-spacing: -0.02em; }
.milkdown .ProseMirror blockquote { background: var(--gmd-code-bg); padding: 0.6em 1em; }
```

## Verifying

The app shows a banner for invalid settings or a missing theme file. The repo's
`npm test` only validates the repo `config/settings.json`; for the per-user
copy, check it parses as JSON and uses only keys listed above.
