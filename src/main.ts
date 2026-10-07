/**
 * Document window controller: one window, one file.
 */

import "@milkdown/crepe/theme/common/prosemirror.css";
import "@milkdown/crepe/theme/common/reset.css";
import "@milkdown/crepe/theme/common/block-edit.css";
import "@milkdown/crepe/theme/common/code-mirror.css";
import "@milkdown/crepe/theme/common/cursor.css";
import "@milkdown/crepe/theme/common/link-tooltip.css";
import "@milkdown/crepe/theme/common/list-item.css";
import "@milkdown/crepe/theme/common/placeholder.css";
import "@milkdown/crepe/theme/common/toolbar.css";
import "@milkdown/crepe/theme/common/table.css";
import "./styles/base.css";

import { languages } from "@codemirror/language-data";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { message, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { EditorView as SourceView } from "@codemirror/view";
import { editorViewCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView as ProseView } from "@milkdown/kit/prose/view";
import { bodyToSave, createEditor, type Editor, resolveStyle } from "./editor";
import { cmFindable, type Findable, type FindStatus, proseFindable } from "./find";
import {
  type DocParts,
  detectStyle,
  emptyDocument,
  fileName,
  isOpenablePath,
  isPlainTextPath,
  joinDocument,
  resolveLocalPath,
  splitDocument,
} from "./markdown";
import {
  type Heading,
  proseHeadings,
  renderOutline,
  setActiveOutline,
  sourceHeadings,
} from "./outline";
import type { Settings } from "./settings";
import { createSourceEditor, fromSourceText, setLineNumbers, toSourceText } from "./source";
import { applyAppearance, applyTheme, loadConfig } from "./theme";

const appWindow = getCurrentWindow();
const scroller = document.getElementById("scroller") as HTMLElement;
const pageEl = document.getElementById("page") as HTMLElement;
const editorRoot = document.getElementById("editor") as HTMLElement;
const sourceRoot = document.getElementById("source") as HTMLElement;
const outlineEl = document.getElementById("outline") as HTMLElement;
const outlineList = outlineEl.querySelector("ul") as HTMLElement;
const findbar = document.getElementById("findbar") as HTMLElement;
const findInput = findbar.querySelector('input[type="search"]') as HTMLInputElement;
const findCase = findbar.querySelector('input[type="checkbox"]') as HTMLInputElement;
const findCount = findbar.querySelector(".gmd-find-count") as HTMLElement;
const frontmatterBox = document.getElementById("frontmatter") as HTMLDetailsElement;
const frontmatterInput = frontmatterBox.querySelector("textarea") as HTMLTextAreaElement;
const banner = document.getElementById("banner") as HTMLElement;

/** Logs to the terminal running `tauri dev`; a no-op in release builds. */
function debug(message: string): void {
  if (import.meta.env.DEV) void invoke("dev_log", { message });
}

if (import.meta.env.DEV) {
  window.addEventListener("error", (e) => debug(`error: ${e.message}`));
  window.addEventListener("unhandledrejection", (e) => debug(`unhandled rejection: ${e.reason}`));
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let settings: Settings;
let configWarnings: string[] = [];
let editor: Editor | null = null;

let path: string | null = null;
/** The file as last read from / written to disk. */
let diskText: string | null = null;
/** Parts of the loaded file; `body` is the original body text. */
let doc: DocParts = emptyDocument();
/** Editor markdown right after loading, for dirty detection. */
let baseline = "";
let dirty = false;
/** Set when editor settings changed while there were unsaved edits. */
let forceDirty = false;
let fileMissing = false;

/** The source-mode editor while source mode is on. */
let source: SourceView | null = null;
/** Source text when source mode was entered (or last synced from disk). */
let sourceEntryText = "";
/** The rich editor no longer matches the document (disk reload, settings). */
let richStale = false;

// ---------------------------------------------------------------------------
// Loading and editing
// ---------------------------------------------------------------------------

async function mountEditor(body: string): Promise<void> {
  const scrollTop = scroller.scrollTop;
  if (editor) await editor.destroy();
  editorRoot.replaceChildren();
  editor = await createEditor({
    root: editorRoot,
    markdown: body,
    settings: settings.editor,
    style: resolveStyle(settings.editor, detectStyle(doc.body)),
    languages,
    resolveImage,
    onChange: () => updateDirty(),
    onSourceMode: () => setTimeout(() => serially(enterSourceMode)),
  });
  editorRoot
    .querySelector(".ProseMirror")
    ?.setAttribute("spellcheck", String(settings.editor.spellcheck));
  scroller.scrollTop = scrollTop;
  onViewReplaced();
}

function proseView(): ProseView | null {
  return editor ? editor.editor.action((ctx) => ctx.get(editorViewCtx)) : null;
}

/** Shows `raw` file text as a clean (unmodified) document. */
async function showDocument(raw: string | null): Promise<void> {
  doc = raw === null ? emptyDocument() : splitDocument(raw);
  diskText = raw;
  forceDirty = false;
  fileMissing = false;
  renderFrontmatter();
  if (source) {
    // Keep editing in source mode; the rich editor is rebuilt on exit.
    sourceEntryText = toSourceText(raw);
    richStale = true;
    source.dispatch({
      changes: { from: 0, to: source.state.doc.length, insert: sourceEntryText },
    });
  } else {
    await mountEditor(doc.body);
    baseline = editor!.getMarkdown();
  }
  setDirty(false);
  hideBanner();
  debug(`showing ${path ?? "untitled"} (${raw?.length ?? 0} chars)`);
}

function renderFrontmatter(): void {
  frontmatterBox.hidden = doc.frontmatter === null;
  frontmatterInput.value = doc.frontmatter ?? "";
  autosizeFrontmatter();
}

function autosizeFrontmatter(): void {
  frontmatterInput.style.height = "auto";
  frontmatterInput.style.height = `${frontmatterInput.scrollHeight}px`;
}

frontmatterInput.addEventListener("input", () => {
  autosizeFrontmatter();
  updateDirty();
});

function currentFrontmatter(): string | null {
  return doc.frontmatter === null ? null : frontmatterInput.value;
}

function updateDirty(): void {
  if (source) {
    setDirty(sourceFileText() !== (diskText ?? ""));
  } else if (editor) {
    setDirty(
      forceDirty || editor.getMarkdown() !== baseline || currentFrontmatter() !== doc.frontmatter,
    );
  }
  scheduleOutline();
  if (!findbar.hidden) showFindStatus(findable()?.status());
}

/** File text for the rich editor's current content. */
function richFileText(): string {
  const body = diskText === null ? editor!.getMarkdown() : bodyToSave(editor!, doc.body);
  return joinDocument({ ...doc, frontmatter: currentFrontmatter(), body });
}

/** File text for the source editor's current content. */
function sourceFileText(): string {
  return fromSourceText(source!.state.doc.toString(), doc.bom, doc.eol);
}

function setDirty(value: boolean): void {
  if (value !== dirty) {
    dirty = value;
    void invoke("set_dirty", { dirty });
  }
  updateTitle();
}

function updateTitle(): void {
  const title = `${dirty ? "● " : ""}${fileName(path)}`;
  document.title = title;
  void appWindow.setTitle(title);
}

async function loadWindowFile(): Promise<void> {
  path = await invoke<string | null>("get_window_path");
  if (!path) {
    await showDocument(null);
    return;
  }
  try {
    await showDocument(await invoke<string>("read_text", { path }));
  } catch (e) {
    await showDocument(null);
    showBanner(String(e).replace(/^not-found: /, "File not found: "));
  }
  // Plain text is edited as-is; ⌘/ still previews it as markdown.
  if (isPlainTextPath(path)) await enterSourceMode();
  showConfigWarnings();
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

async function save(saveAs = false): Promise<boolean> {
  if (!editor) return false;
  let target = path;
  if (!target || saveAs) {
    const markdownFilter = { name: "Markdown", extensions: ["md", "markdown"] };
    const textFilter = { name: "Plain Text", extensions: ["txt"] };
    const chosen = await saveDialog({
      defaultPath: path ?? "Untitled.md",
      filters: isPlainTextPath(path) ? [textFilter, markdownFilter] : [markdownFilter, textFilter],
    });
    if (!chosen) return false;
    target = chosen;
  }
  if (!dirty && target === path && !fileMissing && diskText !== null) return true;

  const text = source ? sourceFileText() : richFileText();
  try {
    await invoke("write_text", { path: target, contents: text });
  } catch (e) {
    showBanner(String(e));
    return false;
  }

  debug(`saved ${target} (${text.length} chars)`);
  diskText = text;
  if (source) {
    richStale ||= source.state.doc.toString() !== sourceEntryText;
    doc = splitDocument(text);
  } else {
    doc = { ...doc, frontmatter: currentFrontmatter(), body: splitDocument(text).body };
    baseline = editor.getMarkdown();
  }
  forceDirty = false;
  fileMissing = false;
  if (target !== path) {
    path = target;
    await invoke("set_window_path", { path });
  }
  setDirty(false);
  hideBanner();
  return true;
}

// ---------------------------------------------------------------------------
// External changes
// ---------------------------------------------------------------------------

async function onFileChanged(): Promise<void> {
  if (!path) return;
  let raw: string;
  try {
    raw = await invoke<string>("read_text", { path });
  } catch (e) {
    if (String(e).startsWith("not-found")) {
      fileMissing = true;
      showBanner("This file was moved or deleted on disk. Save to write it back.");
    } else {
      showBanner(String(e));
    }
    return;
  }
  if (raw === diskText) {
    if (fileMissing) hideBanner();
    fileMissing = false;
    return;
  }
  if (!dirty) {
    await showDocument(raw);
    return;
  }
  debug("external change while dirty; showing conflict banner");
  showBanner("This file changed on disk while you have unsaved edits.", [
    {
      label: "Reload from disk",
      action: async () => {
        if (path) await showDocument(await invoke<string>("read_text", { path }));
      },
    },
    {
      label: "Keep mine",
      action: () => {
        // Saving will overwrite the disk version; don't ask again for it.
        diskText = raw;
        fileMissing = false;
        hideBanner();
      },
    },
  ]);
}

async function onConfigChanged(): Promise<void> {
  const previousEditor = JSON.stringify(settings.editor);
  const config = await loadConfig();
  settings = config.settings;
  configWarnings = config.warnings;
  applyTheme(config.themeCss);
  applyAppearance(settings.appearance);
  showConfigWarnings();
  debug(`config reloaded (${config.warnings.length} warnings)`);

  if (source && JSON.stringify(settings.editor) !== previousEditor) {
    richStale = true;
  } else if (editor && JSON.stringify(settings.editor) !== previousEditor) {
    // Rebuild the editor with new options, keeping any unsaved edits.
    if (dirty) {
      const markdown = editor.getMarkdown();
      forceDirty = true;
      await mountEditor(markdown);
    } else {
      await mountEditor(doc.body);
      baseline = editor.getMarkdown();
    }
    updateDirty();
  }
}

// ---------------------------------------------------------------------------
// Source mode
// ---------------------------------------------------------------------------

async function toggleSourceMode(): Promise<void> {
  await (source ? exitSourceMode() : enterSourceMode());
}

async function enterSourceMode(): Promise<void> {
  if (!editor || source) return;
  const raw = dirty || diskText === null ? richFileText() : diskText;
  const ratio = scrollRatio();
  sourceEntryText = toSourceText(raw);
  richStale = false;
  pageEl.hidden = true;
  sourceRoot.hidden = false;
  source = createSourceEditor({
    root: sourceRoot,
    text: sourceEntryText,
    spellcheck: settings.editor.spellcheck,
    lineNumbers: showLineNumbers,
    plain: isPlainTextPath(path),
    languages,
    onChange: () => updateDirty(),
  });
  setScrollRatio(ratio);
  onViewReplaced();
  updateDirty();
  if (findbar.hidden) source.focus();
  debug("source mode on");
}

async function exitSourceMode(): Promise<void> {
  if (!source) return;
  const text = source.state.doc.toString();
  const changed = richStale || text !== sourceEntryText;
  const raw = sourceFileText();
  const ratio = scrollRatio();
  source.destroy();
  source = null;
  sourceRoot.replaceChildren();
  sourceRoot.hidden = true;
  pageEl.hidden = false;

  if (changed) {
    // The rich editor is rebuilt from the source text; saving diffs against
    // that text, so lines untouched since then keep their exact bytes.
    doc = splitDocument(raw);
    renderFrontmatter();
    await mountEditor(doc.body);
    baseline = editor!.getMarkdown();
    forceDirty = raw !== (diskText ?? "");
    richStale = false;
  } else {
    onViewReplaced();
  }
  setScrollRatio(ratio);
  updateDirty();
  if (findbar.hidden) proseView()?.focus();
  debug("source mode off");
}

function scrollRatio(): number {
  const max = scroller.scrollHeight - scroller.clientHeight;
  return max > 0 ? scroller.scrollTop / max : 0;
}

function setScrollRatio(ratio: number): void {
  requestAnimationFrame(() => {
    scroller.scrollTop = ratio * (scroller.scrollHeight - scroller.clientHeight);
  });
}

/** Re-attaches find and outline after the active editor changes. */
function onViewReplaced(): void {
  refreshOutline();
  if (!findbar.hidden) runFind();
}

// ---------------------------------------------------------------------------
// Find
// ---------------------------------------------------------------------------

function findable(): Findable | null {
  if (source) return cmFindable(source);
  if (editor) return proseFindable(() => proseView()!);
  return null;
}

function openFind(): void {
  findbar.hidden = false;
  findInput.focus();
  findInput.select();
  if (findInput.value) runFind();
}

function closeFind(): void {
  if (findbar.hidden) return;
  findable()?.clear();
  findbar.hidden = true;
  if (source) source.focus();
  else proseView()?.focus();
}

function runFind(): void {
  const status = findable()?.setQuery({
    text: findInput.value,
    caseSensitive: findCase.checked,
  });
  showFindStatus(status);
}

function stepFind(direction: 1 | -1): void {
  if (findbar.hidden) {
    openFind();
    return;
  }
  showFindStatus(findable()?.step(direction));
}

function showFindStatus(status: FindStatus | undefined): void {
  const { count, current } = status ?? { count: 0, current: -1 };
  const empty = findInput.value === "";
  findCount.textContent = empty ? "" : count === 0 ? "No results" : `${current + 1} of ${count}`;
  findbar.classList.toggle("no-match", !empty && count === 0);
}

findInput.addEventListener("input", runFind);
findCase.addEventListener("change", () => {
  runFind();
  findInput.focus();
});
findInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    stepFind(event.shiftKey ? -1 : 1);
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeFind();
  }
});
findbar.addEventListener("click", (event) => {
  const action = (event.target as HTMLElement).closest("button")?.dataset.find;
  if (action === "next") stepFind(1);
  if (action === "prev") stepFind(-1);
  if (action === "close") closeFind();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !findbar.hidden && !event.defaultPrevented) closeFind();
});

// ---------------------------------------------------------------------------
// Line numbers (source mode)
// ---------------------------------------------------------------------------

const LINE_NUMBERS_KEY = "gmd.lineNumbers";
let showLineNumbers = false;
try {
  showLineNumbers = localStorage.getItem(LINE_NUMBERS_KEY) === "1";
} catch {
  // Default: off.
}

function toggleLineNumbers(): void {
  showLineNumbers = !showLineNumbers;
  try {
    localStorage.setItem(LINE_NUMBERS_KEY, showLineNumbers ? "1" : "0");
  } catch {
    // Storage unavailable; the choice just isn't remembered.
  }
  if (source) setLineNumbers(source, showLineNumbers);
  else if (showLineNumbers) showBanner("Line numbers show in source mode (⌘/).");
}

// ---------------------------------------------------------------------------
// Outline
// ---------------------------------------------------------------------------

const OUTLINE_KEY = "gmd.outline";
let headings: Heading[] = [];
let outlineTimer: ReturnType<typeof setTimeout> | undefined;

function toggleOutline(): void {
  outlineEl.hidden = !outlineEl.hidden;
  try {
    localStorage.setItem(OUTLINE_KEY, outlineEl.hidden ? "0" : "1");
  } catch {
    // Storage unavailable; the choice just isn't remembered.
  }
  refreshOutline();
}

function scheduleOutline(): void {
  if (outlineEl.hidden) return;
  clearTimeout(outlineTimer);
  outlineTimer = setTimeout(refreshOutline, 200);
}

function refreshOutline(): void {
  if (outlineEl.hidden) return;
  const view = source ? null : proseView();
  headings = source ? sourceHeadings(source.state.doc.toString()) : view ? proseHeadings(view) : [];
  renderOutline(outlineList, headings, jumpToHeading);
  updateActiveHeading();
}

function jumpToHeading(heading: Heading): void {
  if (source) {
    source.dispatch({
      selection: { anchor: heading.pos },
      effects: SourceView.scrollIntoView(heading.pos, { y: "start", yMargin: 24 }),
    });
    source.focus();
    return;
  }
  const view = proseView();
  if (!view) return;
  const dom = view.nodeDOM(heading.pos);
  if (dom instanceof HTMLElement) {
    scroller.scrollTo({ top: headingTop(dom.getBoundingClientRect().top) - 24 });
  }
  const end = heading.pos + view.state.doc.nodeAt(heading.pos)!.nodeSize - 1;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)));
  view.focus();
}

/** Converts a viewport y coordinate to a scroller offset. */
function headingTop(viewportY: number): number {
  return viewportY - scroller.getBoundingClientRect().top + scroller.scrollTop;
}

function updateActiveHeading(): void {
  if (outlineEl.hidden || headings.length === 0) return;
  const bounds = scroller.getBoundingClientRect();
  // At the end of the document, headings near the bottom can never reach the
  // top of the view; count any heading on screen instead.
  const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
  const threshold = atBottom ? bounds.bottom - 40 : bounds.top + 80;
  const view = source ? null : proseView();
  let active = -1;
  for (const [i, heading] of headings.entries()) {
    let top: number | null = null;
    if (source) {
      top =
        source.lineBlockAt(Math.min(heading.pos, source.state.doc.length)).top + source.documentTop;
    } else {
      const dom = view?.nodeDOM(heading.pos);
      if (dom instanceof HTMLElement) top = dom.getBoundingClientRect().top;
    }
    if (top === null || top > threshold) break;
    active = i;
  }
  setActiveOutline(outlineList, Math.max(active, 0));
}

scroller.addEventListener("scroll", () => requestAnimationFrame(updateActiveHeading), {
  passive: true,
});

try {
  outlineEl.hidden = localStorage.getItem(OUTLINE_KEY) !== "1";
} catch {
  // Default: hidden.
}

// ---------------------------------------------------------------------------
// Links and images
// ---------------------------------------------------------------------------

function resolveImage(src: string): string {
  const local = resolveLocalPath(path, src);
  return local ? convertFileSrc(local) : src;
}

editorRoot.addEventListener("click", (event) => {
  const anchor = (event.target as HTMLElement).closest("a");
  if (!anchor) return;
  event.preventDefault();
  if (!(event.metaKey || event.ctrlKey)) return;
  const href = anchor.getAttribute("href") ?? "";
  const local = resolveLocalPath(path, href);
  if (local) {
    if (isOpenablePath(local)) void invoke("open_paths", { paths: [local], reuse: null });
  } else if (/^(https?|mailto):/i.test(href)) {
    void openUrl(href);
  }
});

// Never let the webview navigate away from the editor.
document.addEventListener("click", (event) => {
  if ((event.target as HTMLElement).closest("a[href]")) event.preventDefault();
});

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

interface BannerAction {
  label: string;
  action: () => void | Promise<void>;
}

function showBanner(text: string, actions: BannerAction[] = []): void {
  (banner.querySelector(".gmd-banner-text") as HTMLElement).textContent = text;
  const container = banner.querySelector(".gmd-banner-actions") as HTMLElement;
  const buttons = [...actions, { label: "Dismiss", action: hideBanner }].map(
    ({ label, action }) => {
      const button = document.createElement("button");
      button.textContent = label;
      button.addEventListener("click", () => void action());
      return button;
    },
  );
  container.replaceChildren(...buttons);
  banner.hidden = false;
}

function hideBanner(): void {
  banner.hidden = true;
}

function showConfigWarnings(): void {
  if (configWarnings.length > 0) {
    showBanner(`Config: ${configWarnings.join(" ")}`);
  }
}

/** Runs async handlers one at a time so bursts of watcher events can't race. */
let queue: Promise<void> = Promise.resolve();
function serially(task: () => Promise<void>): void {
  queue = queue.then(task).catch((e) => {
    debug(`handler failed: ${e}`);
    showBanner(String(e));
  });
}

// ---------------------------------------------------------------------------
// Window events
// ---------------------------------------------------------------------------

async function confirmClose(): Promise<boolean> {
  if (!dirty) return true;
  const choice = await message(`Do you want to save changes to “${fileName(path)}”?`, {
    title: "Unsaved changes",
    kind: "warning",
    buttons: { yes: "Save", no: "Don't Save", cancel: "Cancel" },
  });
  if (choice === "Save" || choice === "Yes") return save();
  return choice === "Don't Save" || choice === "No";
}

async function main(): Promise<void> {
  const config = await loadConfig();
  settings = config.settings;
  configWarnings = config.warnings;
  applyTheme(config.themeCss);
  applyAppearance(settings.appearance);

  await loadWindowFile();

  await appWindow.listen<string>("menu", ({ payload }) => {
    if (payload === "save") void save();
    if (payload === "save_as") void save(true);
    if (payload === "find") openFind();
    if (payload === "find_next") stepFind(1);
    if (payload === "find_prev") stepFind(-1);
    if (payload === "toggle_outline") toggleOutline();
    if (payload === "toggle_line_numbers") toggleLineNumbers();
    if (payload === "toggle_source") serially(toggleSourceMode);
  });
  await appWindow.listen<string>("update-progress", ({ payload }) => {
    if (payload) showBanner(payload);
    else hideBanner();
  });
  await appWindow.listen("file-changed", () => serially(onFileChanged));
  await appWindow.listen("load-file", () => serially(loadWindowFile));
  await appWindow.listen("config-changed", () => serially(onConfigChanged));
  await appWindow.onCloseRequested(async (event) => {
    if (!(await confirmClose())) event.preventDefault();
  });
  await getCurrentWebview().onDragDropEvent(({ payload }) => {
    if (payload.type !== "drop") return;
    const paths = payload.paths.filter(isOpenablePath);
    if (paths.length > 0) {
      void invoke("open_paths", { paths, reuse: dirty || path ? null : appWindow.label });
    }
  });

  if (source) source.focus();
  else (editorRoot.querySelector(".ProseMirror") as HTMLElement | null)?.focus();
}

void main();
