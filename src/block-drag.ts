/**
 * Moves blocks by dragging the block handle, using pointer events.
 *
 * Crepe's handle relies on HTML5 drag-and-drop, but Tauri's file-drop handler
 * (which opens markdown files dropped on the window) consumes every native
 * drag before the webview sees it. So the handle's native drag is turned off
 * and the move is tracked here instead: the handle's mousedown already selects
 * the block, and releasing the pointer moves that selection to the nearest
 * valid gap, shown by an indicator line while dragging.
 */

import { NodeSelection, Plugin } from "@milkdown/kit/prose/state";
import { dropPoint } from "@milkdown/kit/prose/transform";
import type { EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";

/** Pointer travel (px) before a press on the handle becomes a drag. */
const THRESHOLD = 4;
/** Distance (px) from the scroll container's edge that starts auto-scroll. */
const SCROLL_EDGE = 40;

function scrollParent(el: HTMLElement): HTMLElement {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (/(auto|scroll)/.test(overflowY) && node.scrollHeight > node.clientHeight) return node;
  }
  return document.scrollingElement as HTMLElement;
}

/** Where a block at `pos` should be dropped for a pointer at `y`, or null. */
function targetAt(view: EditorView, selection: NodeSelection, x: number, y: number) {
  const rect = view.dom.getBoundingClientRect();
  const left = Math.min(Math.max(x, rect.left + 1), rect.right - 1);
  const hit = view.posAtCoords({ left, top: y });
  if (!hit) return null;
  const pos = dropPoint(view.state.doc, hit.pos, selection.content());
  if (pos === null || (pos >= selection.from && pos <= selection.to)) return null;
  return pos;
}

/** Screen rectangle for the indicator line at block boundary `pos`. */
function indicatorRect(view: EditorView, pos: number) {
  const $pos = view.state.doc.resolve(pos);
  const after = $pos.nodeAfter && view.nodeDOM(pos);
  if (after instanceof HTMLElement) {
    const r = after.getBoundingClientRect();
    return { left: r.left, width: r.width, top: r.top };
  }
  const before = $pos.nodeBefore && view.nodeDOM(pos - $pos.nodeBefore.nodeSize);
  if (before instanceof HTMLElement) {
    const r = before.getBoundingClientRect();
    return { left: r.left, width: r.width, top: r.bottom };
  }
  const r = view.coordsAtPos(pos);
  return { left: r.left, width: view.dom.clientWidth, top: r.top };
}

export const blockDrag = $prose(
  () =>
    new Plugin({
      view: (view) => {
        const doc = view.dom.ownerDocument;
        let drag: {
          pointerId: number;
          handle: HTMLElement;
          startX: number;
          startY: number;
          active: boolean;
          target: number | null;
          x: number;
          y: number;
        } | null = null;
        let indicator: HTMLElement | null = null;
        let scrollFrame = 0;

        const update = () => {
          if (!drag?.active) return;
          const selection = view.state.selection;
          if (!(selection instanceof NodeSelection)) return;
          drag.target = targetAt(view, selection, drag.x, drag.y);
          if (drag.target === null) {
            indicator?.remove();
            indicator = null;
            return;
          }
          if (!indicator) {
            indicator = doc.createElement("div");
            indicator.className = "gmd-drop-indicator";
            doc.body.appendChild(indicator);
          }
          const r = indicatorRect(view, drag.target);
          indicator.style.left = `${r.left}px`;
          indicator.style.width = `${r.width}px`;
          indicator.style.top = `${r.top}px`;
        };

        // Scroll while the pointer rests near the top or bottom edge.
        const autoScroll = () => {
          scrollFrame = 0;
          if (!drag?.active) return;
          const scroller = scrollParent(view.dom);
          const bounds =
            scroller === doc.scrollingElement
              ? { top: 0, bottom: window.innerHeight }
              : scroller.getBoundingClientRect();
          let delta = 0;
          if (drag.y < bounds.top + SCROLL_EDGE) delta = -(bounds.top + SCROLL_EDGE - drag.y) / 2;
          else if (drag.y > bounds.bottom - SCROLL_EDGE)
            delta = (drag.y - (bounds.bottom - SCROLL_EDGE)) / 2;
          if (delta !== 0) {
            scroller.scrollTop += delta;
            update();
            scrollFrame = requestAnimationFrame(autoScroll);
          }
        };

        const finish = (commit: boolean) => {
          if (!drag) return;
          const { active, target, handle, pointerId } = drag;
          drag = null;
          if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
          indicator?.remove();
          indicator = null;
          cancelAnimationFrame(scrollFrame);
          scrollFrame = 0;
          doc.body.classList.remove("gmd-block-dragging");
          if (!active || !commit || target === null) return;

          const selection = view.state.selection;
          if (!(selection instanceof NodeSelection)) return;
          const tr = view.state.tr.delete(selection.from, selection.to);
          const insertAt = tr.mapping.map(target);
          tr.insert(insertAt, selection.node);
          tr.setSelection(NodeSelection.create(tr.doc, insertAt));
          view.dispatch(tr.scrollIntoView());
          view.focus();
        };

        const onPointerDown = (event: PointerEvent) => {
          if (event.button !== 0 || !view.editable) return;
          const handle = (event.target as Element | null)?.closest<HTMLElement>(
            ".milkdown-block-handle",
          );
          if (!handle || !view.dom.parentElement?.contains(handle)) return;
          // The native drag would be swallowed by Tauri; track the pointer instead.
          handle.draggable = false;
          handle.setPointerCapture(event.pointerId);
          drag = {
            pointerId: event.pointerId,
            handle,
            startX: event.clientX,
            startY: event.clientY,
            active: false,
            target: null,
            x: event.clientX,
            y: event.clientY,
          };
        };

        const onPointerMove = (event: PointerEvent) => {
          if (!drag || event.pointerId !== drag.pointerId) return;
          drag.x = event.clientX;
          drag.y = event.clientY;
          if (!drag.active) {
            const moved = Math.hypot(drag.x - drag.startX, drag.y - drag.startY);
            // The handle's mousedown selects the block; without that there is nothing to move.
            if (moved < THRESHOLD || !(view.state.selection instanceof NodeSelection)) return;
            drag.active = true;
            doc.body.classList.add("gmd-block-dragging");
          }
          event.preventDefault();
          update();
          if (!scrollFrame) scrollFrame = requestAnimationFrame(autoScroll);
        };

        const onPointerUp = (event: PointerEvent) => {
          if (drag && event.pointerId === drag.pointerId) finish(true);
        };
        const onPointerCancel = () => finish(false);
        const onKeyDown = (event: KeyboardEvent) => {
          if (event.key === "Escape" && drag?.active) {
            event.preventDefault();
            finish(false);
          }
        };

        doc.addEventListener("pointerdown", onPointerDown, true);
        doc.addEventListener("pointermove", onPointerMove, true);
        doc.addEventListener("pointerup", onPointerUp, true);
        doc.addEventListener("pointercancel", onPointerCancel, true);
        doc.addEventListener("keydown", onKeyDown, true);

        return {
          destroy: () => {
            finish(false);
            doc.removeEventListener("pointerdown", onPointerDown, true);
            doc.removeEventListener("pointermove", onPointerMove, true);
            doc.removeEventListener("pointerup", onPointerUp, true);
            doc.removeEventListener("pointercancel", onPointerCancel, true);
            doc.removeEventListener("keydown", onKeyDown, true);
          },
        };
      },
    }),
);
