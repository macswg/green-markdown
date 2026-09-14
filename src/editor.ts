/**
 * Builds the Milkdown/Crepe editor with Green Markdown's features and
 * serializer preferences. Shared by the app and the round-trip tests.
 */

import { HighlightStyle, type LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { CrepeBuilder } from "@milkdown/crepe/builder";
import { blockEdit } from "@milkdown/crepe/feature/block-edit";
import { codeMirror } from "@milkdown/crepe/feature/code-mirror";
import { cursor } from "@milkdown/crepe/feature/cursor";
import { linkTooltip } from "@milkdown/crepe/feature/link-tooltip";
import { listItem } from "@milkdown/crepe/feature/list-item";
import { placeholder } from "@milkdown/crepe/feature/placeholder";
import { table } from "@milkdown/crepe/feature/table";
import { toolbar } from "@milkdown/crepe/feature/toolbar";
import { parserCtx, remarkStringifyOptionsCtx, serializerCtx } from "@milkdown/kit/core";
import { uploadConfig } from "@milkdown/kit/plugin/upload";
import { imageSchema } from "@milkdown/kit/preset/commonmark";
import { $view } from "@milkdown/kit/utils";
import { clearTextInCurrentBlockCommand } from "@milkdown/kit/preset/commonmark";
import { commandsCtx } from "@milkdown/kit/core";
import { details } from "./details";
import { proseFindPlugin } from "./find";
import type { Bullet, DocStyle, HardBreak, Rule } from "./markdown";
import { preserveUnchanged } from "./preserve";
import type { EditorSettings } from "./settings";

export type Editor = CrepeBuilder;

export interface EditorOptions {
  root: HTMLElement;
  markdown: string;
  settings: EditorSettings;
  /** Resolved serializer style; see `resolveStyle`. */
  style: SaveStyle;
  /** Maps an image `src` from the markdown to a URL the webview can load. */
  resolveImage?: (src: string) => string;
  onChange?: (markdown: string) => void;
  /** Adds a "Source mode" entry to the `/` block menu. */
  onSourceMode?: () => void;
  /** Syntax-highlighting grammars for code blocks (omitted in tests). */
  languages?: LanguageDescription[];
}

export interface SaveStyle {
  bullet: Bullet;
  rule: Rule;
  hardBreak: HardBreak;
}

/** Explicit settings win; "auto" uses the file's own style, then defaults. */
export function resolveStyle(settings: EditorSettings, detected: DocStyle): SaveStyle {
  return {
    bullet: settings.bulletChar === "auto" ? (detected.bullet ?? "-") : settings.bulletChar,
    rule: detected.rule ?? "-",
    hardBreak:
      settings.hardBreak === "auto" ? (detected.hardBreak ?? "spaces") : settings.hardBreak,
  };
}

export async function createEditor(options: EditorOptions): Promise<Editor> {
  const { settings, style } = options;
  const crepe = new CrepeBuilder({ root: options.root, defaultValue: options.markdown });

  crepe.editor.config((ctx) => {
    ctx.update(remarkStringifyOptionsCtx, (prev) => ({
      ...prev,
      bullet: style.bullet,
      // Adjacent lists need a different marker to stay separate lists.
      bulletOther: (style.bullet === "*" ? "-" : "*") as Bullet,
      rule: style.rule,
      handlers: {
        ...prev.handlers,
        ...(style.hardBreak === "spaces" ? { break: () => "  \n" } : {}),
      },
    }));
    // Pasted/dropped image files are not handled yet (Phase 2: save to ./assets).
    ctx.update(uploadConfig.key, (prev) => ({ ...prev, uploader: async () => [] }));
  });

  crepe.editor.use(imageView(options.resolveImage ?? ((src) => src))).use(proseFindPlugin).use(details);

  crepe
    .addFeature(listItem)
    .addFeature(linkTooltip)
    .addFeature(cursor)
    .addFeature(table)
    .addFeature(codeMirror, { languages: options.languages ?? [], theme: codeTheme })
    .addFeature(placeholder, { text: settings.placeholder, mode: "doc" });
  const onSourceMode = options.onSourceMode;
  if (settings.blockHandle) {
    crepe.addFeature(blockEdit, {
      buildMenu: (builder) => {
        if (!onSourceMode) return;
        builder.addGroup("view", "View").addItem("source-mode", {
          label: "Source mode",
          icon: SOURCE_ICON,
          onRun: (ctx) => {
            ctx.get(commandsCtx).call(clearTextInCurrentBlockCommand.key);
            onSourceMode();
          },
        });
      },
    });
  }
  if (settings.selectionToolbar) crepe.addFeature(toolbar);

  if (options.onChange) {
    const onChange = options.onChange;
    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown) => onChange(markdown));
    });
  }

  await crepe.create();
  return crepe;
}

/** Parses and re-serializes `markdown` with the editor's own pipeline. */
export function reserialize(editor: Editor, markdown: string): string {
  return editor.editor.action((ctx) => ctx.get(serializerCtx)(ctx.get(parserCtx)(markdown)));
}

/**
 * The body to write for the edited document: the original text with only the
 * edited regions replaced, or the full serializer output if the minimal merge
 * would not reproduce the same document.
 */
export function bodyToSave(editor: Editor, originalBody: string): string {
  const current = editor.getMarkdown();
  const merged = preserveUnchanged(originalBody, reserialize(editor, originalBody), current);
  if (merged === current) return current;
  return reserialize(editor, merged) === reserialize(editor, current) ? merged : current;
}

const SOURCE_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>';

/** Renders images through `resolve` so relative paths load from disk. */
function imageView(resolve: (src: string) => string) {
  return $view(imageSchema.node, () => (initialNode) => {
    const dom = document.createElement("img");
    const render = (node: typeof initialNode) => {
      dom.src = resolve(node.attrs.src as string);
      dom.alt = node.attrs.alt as string;
      dom.title = (node.attrs.title as string) ?? "";
    };
    render(initialNode);
    return {
      dom,
      update: (node) => {
        if (node.type !== initialNode.type) return false;
        render(node);
        return true;
      },
    };
  });
}

// Code block colors come from theme.css variables so themes (and Claude) can
// restyle syntax highlighting without touching code.
const codeTheme = [
  EditorView.theme({
    "&": { backgroundColor: "transparent", color: "var(--gmd-code-text)" },
    ".cm-content": { caretColor: "var(--gmd-text)" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--gmd-text)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "var(--gmd-selection)",
    },
    ".cm-activeLine": { backgroundColor: "transparent" },
    ".cm-gutters": {
      backgroundColor: "transparent",
      color: "var(--gmd-text-muted)",
      border: "none",
    },
    ".cm-activeLineGutter": { backgroundColor: "transparent" },
  }),
  syntaxHighlighting(
    HighlightStyle.define([
      {
        tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword],
        color: "var(--gmd-syntax-keyword)",
      },
      { tag: [t.string, t.special(t.string), t.regexp], color: "var(--gmd-syntax-string)" },
      { tag: [t.number, t.bool, t.null, t.atom], color: "var(--gmd-syntax-number)" },
      {
        tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
        color: "var(--gmd-syntax-comment)",
        fontStyle: "italic",
      },
      {
        tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName],
        color: "var(--gmd-syntax-function)",
      },
      {
        tag: [t.typeName, t.className, t.namespace, t.definition(t.typeName)],
        color: "var(--gmd-syntax-type)",
      },
      { tag: [t.propertyName, t.attributeName], color: "var(--gmd-syntax-property)" },
      { tag: [t.tagName, t.heading], color: "var(--gmd-syntax-tag)" },
      { tag: [t.operator, t.punctuation, t.bracket], color: "var(--gmd-syntax-punctuation)" },
      { tag: [t.variableName, t.definition(t.variableName)], color: "var(--gmd-code-text)" },
      { tag: t.invalid, color: "var(--gmd-syntax-invalid)" },
      { tag: t.strong, fontWeight: "bold" },
      { tag: t.emphasis, fontStyle: "italic" },
      { tag: t.link, textDecoration: "underline" },
    ]),
  ),
];
