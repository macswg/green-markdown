import { afterEach, describe, expect, test } from "vitest";
import { editorViewCtx } from "@milkdown/kit/core";
import { createEditor, type Editor, resolveStyle } from "../src/editor";
import { findMatches, nearestMatch, proseFindable } from "../src/find";
import { detectStyle } from "../src/markdown";
import { proseHeadings, sourceHeadings } from "../src/outline";
import { DEFAULT_SETTINGS } from "../src/settings";
import { fromSourceText, toSourceText } from "../src/source";

describe("findMatches", () => {
  test("case-insensitive by default, non-overlapping", () => {
    expect(findMatches("Aaa aA", { text: "aa", caseSensitive: false })).toEqual([
      { from: 0, to: 2 },
      { from: 4, to: 6 },
    ]);
  });
  test("case-sensitive", () => {
    expect(findMatches("Foo foo", { text: "foo", caseSensitive: true })).toEqual([
      { from: 4, to: 7 },
    ]);
  });
  test("empty query matches nothing", () => {
    expect(findMatches("abc", { text: "", caseSensitive: false })).toEqual([]);
  });
  test("nearestMatch wraps", () => {
    const m = [
      { from: 2, to: 3 },
      { from: 8, to: 9 },
    ];
    expect(nearestMatch(m, 5)).toBe(1);
    expect(nearestMatch(m, 9)).toBe(0);
    expect(nearestMatch([], 0)).toBe(-1);
  });
});

describe("sourceHeadings", () => {
  test("ATX and setext, skipping fences and front matter", () => {
    const text = [
      "---",
      "title: # not a heading",
      "---",
      "# One",
      "text",
      "```",
      "# code",
      "```",
      "Two **bold**",
      "---",
      "### Three ###",
    ].join("\n");
    const h = sourceHeadings(text);
    expect(h.map((x) => [x.level, x.text])).toEqual([
      [1, "One"],
      [2, "Two bold"],
      [3, "Three"],
    ]);
    expect(text.slice(h[0].pos).startsWith("# One")).toBe(true);
    expect(text.slice(h[1].pos).startsWith("Two")).toBe(true);
  });
});

describe("source text", () => {
  test("round-trips BOM and CRLF", () => {
    const raw = "﻿# a\r\nb\r\n";
    expect(toSourceText(raw)).toBe("# a\nb\n");
    expect(fromSourceText(toSourceText(raw), true, "\r\n")).toBe(raw);
  });
});

describe("rich editor", () => {
  let editor: Editor | null = null;
  afterEach(async () => {
    await editor?.destroy();
    document.body.innerHTML = "";
  });

  test("finds text and lists headings", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const md = "# Title\n\nhello world\n\n## Sub\n\nWorld again";
    editor = await createEditor({
      root,
      markdown: md,
      settings: DEFAULT_SETTINGS.editor,
      style: resolveStyle(DEFAULT_SETTINGS.editor, detectStyle(md)),
    });
    const view = editor.editor.action((ctx) => ctx.get(editorViewCtx));
    const find = proseFindable(() => view);
    expect(find.setQuery({ text: "world", caseSensitive: false }).count).toBe(2);
    expect(find.step(1).current).toBe(1);
    expect(find.step(1).current).toBe(0);
    const { from, to } = view.state.selection;
    expect(view.state.doc.textBetween(from, to).toLowerCase()).toBe("world");
    expect(root.querySelectorAll(".gmd-find-match").length).toBe(2);
    find.clear();
    expect(find.status().count).toBe(0);

    expect(proseHeadings(view).map((h) => [h.level, h.text])).toEqual([
      [1, "Title"],
      [2, "Sub"],
    ]);
  });
});
