/**
 * Source mode: the whole file (front matter included) as plain text in
 * CodeMirror, so edits are byte-exact.
 */

import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { type LanguageDescription, syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { Compartment, EditorState } from "@codemirror/state";
import { drawSelection, EditorView, keymap, lineNumbers } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { cmFindExtension } from "./find";
import { hoverLine } from "./hover-line";

export interface SourceOptions {
  root: HTMLElement;
  text: string;
  spellcheck: boolean;
  lineNumbers: boolean;
  /** Plain text: no markdown parsing or highlighting. */
  plain?: boolean;
  languages?: LanguageDescription[];
  onChange: () => void;
}

const gutter = new Compartment();

export function createSourceEditor(options: SourceOptions): EditorView {
  return new EditorView({
    parent: options.root,
    state: EditorState.create({
      doc: options.text,
      extensions: [
        history(),
        drawSelection(),
        EditorView.lineWrapping,
        gutter.of(options.lineNumbers ? [lineNumbers(), hoverLine] : []),
        // Mod-/ belongs to the app (source mode toggle), not toggle-comment.
        keymap.of([
          indentWithTab,
          ...defaultKeymap.filter((binding) => binding.key !== "Mod-/"),
          ...historyKeymap,
        ]),
        options.plain
          ? []
          : [
              markdown({ codeLanguages: options.languages ?? [] }),
              syntaxHighlighting(sourceHighlight),
            ],
        cmFindExtension,
        sourceTheme,
        EditorView.contentAttributes.of({ spellcheck: String(options.spellcheck) }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) options.onChange();
        }),
      ],
    }),
  });
}

export function setLineNumbers(view: EditorView, on: boolean): void {
  view.dispatch({ effects: gutter.reconfigure(on ? [lineNumbers(), hoverLine] : []) });
}

/** Text with BOM removed and CRLF normalized; what source mode edits. */
export function toSourceText(raw: string | null): string {
  return (raw ?? "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
}

/** Inverse of `toSourceText` for a file that had `bom` / `eol`. */
export function fromSourceText(text: string, bom: boolean, eol: "\n" | "\r\n"): string {
  return (bom ? "\uFEFF" : "") + (eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text);
}

const sourceTheme = EditorView.theme({
  "&": {
    backgroundColor: "transparent",
    color: "var(--gmd-text)",
    fontSize: "var(--gmd-source-font-size)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--gmd-font-mono)",
    lineHeight: "1.6",
    overflow: "visible",
  },
  ".cm-content": {
    boxSizing: "content-box",
    maxWidth: "var(--gmd-content-width)",
    margin: "0 auto",
    padding: "var(--gmd-page-padding-top) var(--gmd-page-padding-x) var(--gmd-page-padding-bottom)",
    caretColor: "var(--gmd-text)",
  },
  ".cm-line": { padding: "0" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--gmd-text-muted)",
    border: "none",
    fontFamily: "var(--gmd-font-mono)",
    lineHeight: "1.6",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 12px 0 16px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--gmd-text)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "var(--gmd-selection)",
  },
});

const sourceHighlight = HighlightStyle.define([
  { tag: t.heading, color: "var(--gmd-heading-color)", fontWeight: "bold" },
  { tag: [t.strong], fontWeight: "bold" },
  { tag: [t.emphasis], fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "var(--gmd-link-color)" },
  { tag: t.monospace, color: "var(--gmd-inline-code-color)" },
  { tag: t.quote, color: "var(--gmd-blockquote-text)" },
  {
    tag: [t.processingInstruction, t.contentSeparator, t.meta],
    color: "var(--gmd-text-muted)",
  },
  { tag: [t.keyword, t.modifier], color: "var(--gmd-syntax-keyword)" },
  { tag: [t.string, t.regexp], color: "var(--gmd-syntax-string)" },
  { tag: [t.number, t.bool, t.atom], color: "var(--gmd-syntax-number)" },
  { tag: t.comment, color: "var(--gmd-syntax-comment)", fontStyle: "italic" },
  { tag: [t.propertyName, t.attributeName], color: "var(--gmd-syntax-property)" },
  { tag: t.tagName, color: "var(--gmd-syntax-tag)" },
]);
