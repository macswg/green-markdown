/** Document outline: heading extraction and the sidebar that lists them. */

import type { EditorView } from "@milkdown/kit/prose/view";

export interface Heading {
  level: number;
  text: string;
  /** ProseMirror position (rich mode) or character offset (source mode). */
  pos: number;
}

/** ATX and setext headings in raw markdown, skipping fenced code and front matter. */
export function sourceHeadings(text: string): Heading[] {
  const out: Heading[] = [];
  const lines = text.split("\n");
  let offset = 0;
  let fence: string | null = null;
  let start = 0;

  const fm = /^(---|\+\+\+)[ \t]*$/.exec(lines[0] ?? "");
  if (fm) {
    const close = lines.findIndex((l, i) => i > 0 && (l.trim() === fm[1] || l.trim() === "..."));
    if (close > 0) {
      for (let i = 0; i <= close; i++) offset += lines[i].length + 1;
      start = close + 1;
    }
  }

  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    const lineStart = offset;
    offset += line.length + 1;

    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;

    const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (atx) {
      out.push({ level: atx[1].length, text: clean(atx[2] ?? ""), pos: lineStart });
      continue;
    }
    const next = lines[i + 1];
    if (next !== undefined && line.trim() !== "" && !/^\s*([-*+]|\d+[.)])\s/.test(line)) {
      const setext = /^ {0,3}(=+|-+)[ \t]*$/.exec(next);
      if (setext) {
        out.push({ level: setext[1][0] === "=" ? 1 : 2, text: clean(line), pos: lineStart });
        offset += next.length + 1;
        i++;
      }
    }
  }
  return out;
}

/** Strips common inline markup so outline entries read as plain text. */
function clean(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|\*|_|`|~~)(.+?)\1/g, "$2")
    .trim();
}

/** Headings in the rich editor's document. */
export function proseHeadings(view: EditorView): Heading[] {
  const out: Heading[] = [];
  view.state.doc.descendants((node, pos) => {
    if (node.type.name === "heading") {
      out.push({ level: node.attrs.level as number, text: node.textContent, pos });
      return false;
    }
    return node.isBlock && !node.isTextblock;
  });
  return out;
}

/** Renders `headings` into `list`; clicking an entry calls `onPick`. */
export function renderOutline(
  list: HTMLElement,
  headings: Heading[],
  onPick: (heading: Heading) => void,
): void {
  if (headings.length === 0) {
    const empty = document.createElement("li");
    empty.className = "gmd-outline-empty";
    empty.textContent = "No headings";
    list.replaceChildren(empty);
    return;
  }
  const minLevel = Math.min(...headings.map((h) => h.level));
  list.replaceChildren(
    ...headings.map((heading) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = heading.text || "(untitled)";
      button.title = heading.text;
      button.style.paddingLeft = `${10 + (heading.level - minLevel) * 14}px`;
      button.dataset.level = String(heading.level);
      button.addEventListener("click", () => onPick(heading));
      item.appendChild(button);
      return item;
    }),
  );
}

/** Marks entry `index` as the one currently in view. */
export function setActiveOutline(list: HTMLElement, index: number): void {
  list.querySelectorAll("button").forEach((b, i) => b.classList.toggle("active", i === index));
}
