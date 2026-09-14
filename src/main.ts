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
import { bodyToSave, createEditor, type Editor, resolveStyle } from "./editor";
import {
  type DocParts,
  detectStyle,
  emptyDocument,
  fileName,
  isMarkdownPath,
  joinDocument,
  resolveLocalPath,
  splitDocument,
} from "./markdown";
import type { Settings } from "./settings";
import { applyAppearance, applyTheme, loadConfig } from "./theme";

const appWindow = getCurrentWindow();
const scroller = document.getElementById("scroller") as HTMLElement;
const editorRoot = document.getElementById("editor") as HTMLElement;
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
  });
  editorRoot
    .querySelector(".ProseMirror")
    ?.setAttribute("spellcheck", String(settings.editor.spellcheck));
  scroller.scrollTop = scrollTop;
}

/** Shows `raw` file text as a clean (unmodified) document. */
async function showDocument(raw: string | null): Promise<void> {
  doc = raw === null ? emptyDocument() : splitDocument(raw);
  diskText = raw;
  forceDirty = false;
  fileMissing = false;
  renderFrontmatter();
  await mountEditor(doc.body);
  baseline = editor!.getMarkdown();
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
  if (!editor) return;
  setDirty(
    forceDirty || editor.getMarkdown() !== baseline || currentFrontmatter() !== doc.frontmatter,
  );
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
  showConfigWarnings();
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

async function save(saveAs = false): Promise<boolean> {
  if (!editor) return false;
  let target = path;
  if (!target || saveAs) {
    const chosen = await saveDialog({
      defaultPath: path ?? "Untitled.md",
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
    });
    if (!chosen) return false;
    target = chosen;
  }
  if (!dirty && target === path && !fileMissing && diskText !== null) return true;

  const body = diskText === null ? editor.getMarkdown() : bodyToSave(editor, doc.body);
  const frontmatter = currentFrontmatter();
  const text = joinDocument({ ...doc, frontmatter, body });
  try {
    await invoke("write_text", { path: target, contents: text });
  } catch (e) {
    showBanner(String(e));
    return false;
  }

  debug(`saved ${target} (${text.length} chars)`);
  diskText = text;
  doc = { ...doc, frontmatter, body };
  baseline = editor.getMarkdown();
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

  if (editor && JSON.stringify(settings.editor) !== previousEditor) {
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
    if (isMarkdownPath(local)) void invoke("open_paths", { paths: [local], reuse: null });
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
  });
  await appWindow.listen("file-changed", () => serially(onFileChanged));
  await appWindow.listen("load-file", () => serially(loadWindowFile));
  await appWindow.listen("config-changed", () => serially(onConfigChanged));
  await appWindow.onCloseRequested(async (event) => {
    if (!(await confirmClose())) event.preventDefault();
  });
  await getCurrentWebview().onDragDropEvent(({ payload }) => {
    if (payload.type !== "drop") return;
    const paths = payload.paths.filter(isMarkdownPath);
    if (paths.length > 0) {
      void invoke("open_paths", { paths, reuse: dirty || path ? null : appWindow.label });
    }
  });

  (editorRoot.querySelector(".ProseMirror") as HTMLElement | null)?.focus();
}

void main();
