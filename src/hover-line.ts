/**
 * Highlights the line under the mouse pointer (row and line number), so it's
 * easy to see which line you're pointing at. Used alongside line numbers.
 */

import { RangeSet, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  gutterLineClass,
  ViewPlugin,
} from "@codemirror/view";

/** Start of the hovered line, or null. */
const setHover = StateEffect.define<number | null>();

const hoverField = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setHover)) return effect.value;
    if (value === null || !tr.docChanged) return value;
    return tr.state.doc.lineAt(tr.changes.mapPos(value)).from;
  },
  provide: (field) => [
    EditorView.decorations.from(field, (pos) =>
      pos === null ? Decoration.none : Decoration.set([lineDeco.range(pos)]),
    ),
    gutterLineClass.from(field, (pos) =>
      pos === null ? RangeSet.empty : RangeSet.of([gutterMarker.range(pos)]),
    ),
  ],
});

const lineDeco = Decoration.line({ class: "cm-hoverLine" });
const gutterMarker = new (class extends GutterMarker {
  elementClass = "cm-hoverLineGutter";
})();

/** Line start at viewport point (x, y), or null when not over a line. */
function lineAt(view: EditorView, x: number, y: number): number | null {
  const rect = view.dom.getBoundingClientRect();
  if (x < rect.left || x > rect.right) return null;
  const height = y - view.documentTop;
  if (height < 0) return null;
  const block = view.lineBlockAtHeight(height);
  return height > block.bottom ? null : block.from;
}

/** Tracks the pointer, including while the page scrolls under it. */
const tracker = ViewPlugin.fromClass(
  class {
    x = 0;
    y = 0;
    inside = false;

    constructor(readonly view: EditorView) {
      document.addEventListener("scroll", this.onScroll, { capture: true, passive: true });
    }

    destroy(): void {
      document.removeEventListener("scroll", this.onScroll, { capture: true });
    }

    onScroll = (): void => {
      if (this.inside) this.refresh();
    };

    refresh(): void {
      const pos = this.inside ? lineAt(this.view, this.x, this.y) : null;
      if (pos !== this.view.state.field(hoverField)) {
        this.view.dispatch({ effects: setHover.of(pos) });
      }
    }
  },
  {
    eventHandlers: {
      mousemove(event) {
        this.x = event.clientX;
        this.y = event.clientY;
        this.inside = true;
        this.refresh();
      },
      mouseleave() {
        this.inside = false;
        this.refresh();
      },
    },
  },
);

const hoverTheme = EditorView.theme({
  // Full-bleed band: the shadow reaches past the centered text column to
  // the gutter, clipped to the line's own height.
  // Translucent so the selection (drawn behind the text) still shows.
  ".cm-line.cm-hoverLine": {
    backgroundColor: "rgba(128, 128, 128, 0.12)",
    boxShadow: "0 0 0 100vmax rgba(128, 128, 128, 0.12)",
    clipPath: "inset(0 -100vmax)",
  },
  ".cm-gutterElement.cm-hoverLineGutter": { color: "var(--gmd-text)" },
});

export const hoverLine = [hoverField, tracker, hoverTheme];
