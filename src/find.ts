/**
 * Find in document, for both the rich editor (a ProseMirror plugin) and
 * source mode (a CodeMirror extension). Both expose the same small interface
 * so the find bar doesn't care which mode is active.
 */

import { type Extension, StateEffect, StateField } from "@codemirror/state";
import { Decoration as CmDecoration, EditorView as CmView } from "@codemirror/view";
import { Plugin, PluginKey, TextSelection } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";

export interface FindQuery {
  text: string;
  caseSensitive: boolean;
}

export interface Range {
  from: number;
  to: number;
}

export interface FindStatus {
  count: number;
  /** Index of the current match, or -1 when there is none. */
  current: number;
}

/** A searchable view: the rich editor or the source editor. */
export interface Findable {
  setQuery(query: FindQuery): FindStatus;
  /** Moves to the next (1) or previous (-1) match and scrolls to it. */
  step(direction: 1 | -1): FindStatus;
  status(): FindStatus;
  clear(): void;
}

/** Non-overlapping matches of `query` in `text`, as string offsets. */
export function findMatches(text: string, query: FindQuery): Range[] {
  if (!query.text) return [];
  const haystack = query.caseSensitive ? text : text.toLowerCase();
  const needle = query.caseSensitive ? query.text : query.text.toLowerCase();
  const out: Range[] = [];
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    out.push({ from: at, to: at + needle.length });
    at = haystack.indexOf(needle, at + needle.length);
  }
  return out;
}

/** Index of the first match at or after `pos`, wrapping to 0. */
export function nearestMatch(matches: Range[], pos: number): number {
  if (matches.length === 0) return -1;
  const i = matches.findIndex((m) => m.from >= pos);
  return i === -1 ? 0 : i;
}

// ---------------------------------------------------------------------------
// Rich editor (ProseMirror)
// ---------------------------------------------------------------------------

interface ProseFindState {
  query: FindQuery;
  matches: Range[];
  current: number;
}

const proseKey = new PluginKey<ProseFindState>("gmd-find");
const EMPTY: ProseFindState = {
  query: { text: "", caseSensitive: false },
  matches: [],
  current: -1,
};

/** Matches within each textblock; inline non-text nodes act as separators. */
function proseMatches(doc: EditorView["state"]["doc"], query: FindQuery): Range[] {
  const out: Range[] = [];
  if (!query.text) return out;
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    let text = "";
    node.forEach((child) => {
      text += child.isText ? child.text : "\uFFFC".repeat(child.nodeSize);
    });
    for (const m of findMatches(text, query)) {
      out.push({ from: pos + 1 + m.from, to: pos + 1 + m.to });
    }
    return false;
  });
  return out;
}

export const proseFindPlugin = $prose(
  () =>
    new Plugin<ProseFindState>({
      key: proseKey,
      state: {
        init: () => EMPTY,
        apply(tr, prev) {
          const meta = tr.getMeta(proseKey) as Partial<ProseFindState> | undefined;
          if (!meta && !tr.docChanged) return prev;
          const query = meta?.query ?? prev.query;
          const matches = meta?.query || tr.docChanged ? proseMatches(tr.doc, query) : prev.matches;
          let current = meta?.current ?? prev.current;
          if (current >= matches.length) current = matches.length - 1;
          return { query, matches, current };
        },
      },
      props: {
        decorations(state) {
          const find = proseKey.getState(state);
          if (!find || find.matches.length === 0) return null;
          return DecorationSet.create(
            state.doc,
            find.matches.map((m, i) =>
              Decoration.inline(m.from, m.to, {
                class: i === find.current ? "gmd-find-match gmd-find-current" : "gmd-find-match",
              }),
            ),
          );
        },
      },
    }),
);

/** Find adapter over the rich editor; `view` returns its ProseMirror view. */
export function proseFindable(view: () => EditorView): Findable {
  const status = (): FindStatus => {
    const s = proseKey.getState(view().state) ?? EMPTY;
    return { count: s.matches.length, current: s.current };
  };
  const select = (index: number) => {
    const v = view();
    const s = proseKey.getState(v.state) ?? EMPTY;
    const tr = v.state.tr.setMeta(proseKey, { current: index });
    const match = s.matches[index];
    if (match) {
      tr.setSelection(TextSelection.create(tr.doc, match.from, match.to)).scrollIntoView();
    }
    v.dispatch(tr);
  };
  return {
    setQuery(query) {
      const v = view();
      v.dispatch(v.state.tr.setMeta(proseKey, { query, current: -1 }));
      const s = proseKey.getState(v.state) ?? EMPTY;
      select(nearestMatch(s.matches, v.state.selection.from));
      return status();
    },
    step(direction) {
      const s = proseKey.getState(view().state) ?? EMPTY;
      if (s.matches.length === 0) return status();
      const n = s.matches.length;
      select(s.current === -1 ? 0 : (s.current + direction + n) % n);
      return status();
    },
    status,
    clear() {
      const v = view();
      v.dispatch(v.state.tr.setMeta(proseKey, { ...EMPTY }));
    },
  };
}

// ---------------------------------------------------------------------------
// Source mode (CodeMirror)
// ---------------------------------------------------------------------------

interface CmFindState {
  query: FindQuery;
  matches: Range[];
  current: number;
}

const setCmFind = StateEffect.define<Partial<CmFindState>>();
const cmMatch = CmDecoration.mark({ class: "gmd-find-match" });
const cmCurrent = CmDecoration.mark({ class: "gmd-find-match gmd-find-current" });

const cmFindField = StateField.define<CmFindState>({
  create: () => EMPTY,
  update(prev, tr) {
    const effect = tr.effects.find((e) => e.is(setCmFind))?.value as
      Partial<CmFindState> | undefined;
    if (!effect && !tr.docChanged) return prev;
    const query = effect?.query ?? prev.query;
    const matches =
      effect?.query || tr.docChanged ? findMatches(tr.state.doc.toString(), query) : prev.matches;
    let current = effect?.current ?? prev.current;
    if (current >= matches.length) current = matches.length - 1;
    return { query, matches, current };
  },
  provide: (field) =>
    CmView.decorations.from(field, (s) =>
      CmDecoration.set(
        s.matches.map((m, i) => (i === s.current ? cmCurrent : cmMatch).range(m.from, m.to)),
      ),
    ),
});

export const cmFindExtension: Extension = cmFindField;

export function cmFindable(view: CmView): Findable {
  const status = (): FindStatus => {
    const s = view.state.field(cmFindField);
    return { count: s.matches.length, current: s.current };
  };
  const select = (index: number) => {
    const match = view.state.field(cmFindField).matches[index];
    view.dispatch({
      effects: [
        setCmFind.of({ current: index }),
        ...(match ? [CmView.scrollIntoView(match.from, { y: "center" })] : []),
      ],
      selection: match ? { anchor: match.from, head: match.to } : undefined,
    });
  };
  return {
    setQuery(query) {
      view.dispatch({ effects: setCmFind.of({ query, current: -1 }) });
      const s = view.state.field(cmFindField);
      select(nearestMatch(s.matches, view.state.selection.main.from));
      return status();
    },
    step(direction) {
      const s = view.state.field(cmFindField);
      if (s.matches.length === 0) return status();
      const n = s.matches.length;
      select(s.current === -1 ? 0 : (s.current + direction + n) % n);
      return status();
    },
    status,
    clear() {
      view.dispatch({ effects: setCmFind.of({ ...EMPTY }) });
    },
  };
}
