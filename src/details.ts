/**
 * `<details>` blocks as collapsible sections in rich mode.
 *
 * GitHub-style markdown writes them as raw HTML around ordinary markdown:
 *
 *     <details>
 *     <summary>Title</summary>
 *
 *     Body **markdown**
 *
 *     </details>
 *
 * remark sees the tags as separate `html` nodes, so a remark plugin folds each
 * matched open/close pair (and everything between) into one `details` node.
 * The opening HTML is kept verbatim and written back unchanged unless the
 * summary is edited. Collapsing is view state only and never touches the file.
 * The single-block form (`<details><summary>…</summary>body</details>`) stays
 * raw HTML.
 */

import type { Node as MdNode } from "@milkdown/transformer";
import { Selection } from "@milkdown/kit/prose/state";
import { $nodeSchema, $remark, $view } from "@milkdown/kit/utils";

type Parent = MdNode & { children: MdNode[] };
type Html = MdNode & { value: string };

const OPEN_RE = /^<details(\s[^>]*)?>\s*(?:<summary>([\s\S]*?)<\/summary>)?\s*$/i;
const SUMMARY_RE = /^<summary>([\s\S]*?)<\/summary>$/i;
const CLOSE_RE = /^<\/details>$/i;

/** The raw HTML of `node` when it is an html block, bare or wrapped in a paragraph. */
function blockHtml(node: MdNode): string | undefined {
  if (node.type === "html") return String((node as Html).value).trim();
  const children = (node as Partial<Parent>).children;
  if (node.type === "paragraph" && children?.length === 1 && children[0].type === "html") {
    return String((children[0] as Html).value).trim();
  }
  return undefined;
}

/** Plain text for display: tags stripped, common entities decoded. */
export function summaryText(html: string): string {
  const text = html.replace(/<[^>]*>/g, "");
  const el = document.createElement("textarea");
  el.innerHTML = text;
  return el.value.trim();
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Folds open/close tag pairs in `children` into details nodes, recursively. */
function foldDetails(children: MdNode[]): MdNode[] {
  const out: MdNode[] = [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const html = blockHtml(child);
    const open = html === undefined ? null : OPEN_RE.exec(html);
    if (!open) {
      const parent = child as Partial<Parent>;
      if (parent.children) parent.children = foldDetails(parent.children);
      out.push(child);
      continue;
    }

    let head = html!;
    let summary = open[2];
    let start = i + 1;
    // `<details>` and `<summary>…</summary>` separated by a blank line.
    if (summary === undefined) {
      const next = children[start] && blockHtml(children[start]);
      const match = next === undefined ? null : SUMMARY_RE.exec(next);
      if (match) {
        head = `${head}\n\n${next}`;
        summary = match[1];
        start++;
      }
    }

    // Find the matching close, counting nested opens.
    let depth = 1;
    let end = start;
    for (; end < children.length; end++) {
      const tag = blockHtml(children[end]);
      if (tag === undefined) continue;
      if (OPEN_RE.test(tag)) depth++;
      else if (CLOSE_RE.test(tag) && --depth === 0) break;
    }
    if (depth !== 0) {
      out.push(child);
      continue;
    }

    out.push({
      type: "details",
      head,
      summary: summary ?? "",
      open: /\sopen(\s|=|$)/i.test(open[1] ?? ""),
      children: foldDetails(children.slice(start, end)),
    } as MdNode);
    i = end;
  }
  return out;
}

export const remarkDetails = $remark("remarkDetails", () => () => (tree: MdNode) => {
  const root = tree as Parent;
  root.children = foldDetails(root.children);
});

export const detailsSchema = $nodeSchema("details", () => ({
  content: "block+",
  group: "block",
  defining: true,
  attrs: {
    /** Opening HTML exactly as written in the file. */
    head: { default: "<details>\n<summary>Details</summary>", validate: "string" },
    /** Inner HTML of `<summary>`. */
    summary: { default: "Details", validate: "string" },
    open: { default: false, validate: "boolean" },
  },
  parseDOM: [
    {
      tag: "details[data-type='details']",
      contentElement: "div[data-details-content]",
      getAttrs: (dom) => ({
        head: dom.dataset.head ?? "",
        summary: dom.dataset.summary ?? "",
        open: dom.hasAttribute("open"),
      }),
    },
  ],
  toDOM: (node) => [
    "details",
    {
      "data-type": "details",
      "data-head": node.attrs.head,
      "data-summary": node.attrs.summary,
      ...(node.attrs.open ? { open: "" } : {}),
    },
    ["summary", summaryText(node.attrs.summary)],
    ["div", { "data-details-content": "" }, 0],
  ],
  parseMarkdown: {
    match: ({ type }) => type === "details",
    runner: (state, node, type) => {
      const { head, summary, open } = node as unknown as {
        head: string;
        summary: string;
        open: boolean;
      };
      state.openNode(type, { head, summary, open });
      const children = node.children ?? [];
      if (children.length) state.next(children);
      else state.openNode(state.schema.nodes.paragraph).closeNode();
      state.closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "details",
    runner: (state, node) => {
      state.addNode("html", undefined, node.attrs.head);
      state.next(node.content);
      state.addNode("html", undefined, "</details>");
    },
  },
}));

/** Native `<details>` with an editable summary and editable body. */
export const detailsView = $view(detailsSchema.node, () => (initialNode, view, getPos) => {
  let node = initialNode;
  const dom = document.createElement("details");
  dom.className = "gmd-details";
  dom.open = initialNode.attrs.open;
  const summary = document.createElement("summary");
  summary.contentEditable = "false";
  const input = document.createElement("input");
  input.className = "gmd-details-summary";
  input.spellcheck = false;
  input.placeholder = "Summary";
  summary.appendChild(input);
  const contentDOM = document.createElement("div");
  contentDOM.className = "gmd-details-content";
  dom.append(summary, contentDOM);

  const render = () => {
    const text = summaryText(node.attrs.summary);
    if (document.activeElement !== input) input.value = text;
  };
  render();

  // Clicking or typing in the field must not toggle the section.
  summary.addEventListener("click", (event) => {
    if (event.target === input) event.preventDefault();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === " ") event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      // Move the cursor into the body.
      const pos = getPos();
      if (pos !== undefined) {
        const { state } = view;
        view.dispatch(state.tr.setSelection(Selection.near(state.doc.resolve(pos + 1))));
        dom.open = true;
        view.focus();
      }
    }
  });
  input.addEventListener("keyup", (event) => {
    if (event.key === " ") event.preventDefault();
  });
  input.addEventListener("change", () => {
    const pos = getPos();
    const text = input.value.trim();
    if (pos === undefined || text === summaryText(node.attrs.summary)) return;
    const html = escapeHtml(text);
    const tagMatch = /^<details(\s[^>]*)?>/i.exec(node.attrs.head);
    const head = `<details${tagMatch?.[1] ?? ""}>\n<summary>${html}</summary>`;
    view.dispatch(
      view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, head, summary: html }),
    );
  });

  return {
    dom,
    contentDOM,
    update: (updated) => {
      if (updated.type !== initialNode.type) return false;
      node = updated;
      render();
      return true;
    },
    stopEvent: (event) => summary.contains(event.target as Node),
    ignoreMutation: (mutation) =>
      summary.contains(mutation.target) ||
      (mutation.type === "attributes" && mutation.target === dom),
  };
});

export const details = [remarkDetails, detailsSchema, detailsView].flat();
