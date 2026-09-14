/**
 * Saving must change only what was edited.
 *
 * - "serializer" tests pin down the raw editor output (the fallback path).
 *   Where it normalizes on purpose, `<name>.expected.md` records the accepted
 *   output so any new normalization shows up as a failing diff.
 * - "minimal-diff save" tests simulate edits and require every untouched line
 *   to keep its original bytes.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { bodyToSave, createEditor, type Editor, reserialize, resolveStyle } from "../src/editor";
import { detectStyle, joinDocument, splitDocument } from "../src/markdown";
import { preserveUnchanged } from "../src/preserve";
import { DEFAULT_SETTINGS } from "../src/settings";

const fixturesDir = join(import.meta.dirname, "fixtures");
const read = (name: string) => readFileSync(join(fixturesDir, name), "utf8");
const fixtures = readdirSync(fixturesDir).filter(
  (f) => f.endsWith(".md") && !f.endsWith(".expected.md"),
);

const editors: Editor[] = [];
afterEach(async () => {
  for (const editor of editors.splice(0)) await editor.destroy();
  document.body.innerHTML = "";
});

async function open(body: string): Promise<Editor> {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const editor = await createEditor({
    root,
    markdown: body,
    settings: DEFAULT_SETTINGS.editor,
    style: resolveStyle(DEFAULT_SETTINGS.editor, detectStyle(body)),
  });
  editors.push(editor);
  return editor;
}

/** Saves `raw` as if the user edited it into `edited`. */
async function saveEdited(raw: string, edited: string): Promise<string> {
  const parts = splitDocument(raw);
  const editor = await open(parts.body);
  const editedBody = splitDocument(edited).body;
  // Stand-in for typing: load the edited text into the same editor.
  const { replaceAll } = await import("@milkdown/kit/utils");
  editor.editor.action(replaceAll(editedBody));
  return joinDocument({ ...parts, body: bodyToSave(editor, parts.body) });
}

describe("serializer", () => {
  for (const name of fixtures) {
    test(name, async () => {
      const raw = read(name);
      const parts = splitDocument(raw);
      const editor = await open(parts.body);
      const expectedName = name.replace(/\.md$/, ".expected.md");
      const expected = existsSync(join(fixturesDir, expectedName)) ? read(expectedName) : raw;
      expect(joinDocument({ ...parts, body: editor.getMarkdown() })).toBe(expected);
    });
  }

  test("front matter and CRLF line endings survive", async () => {
    const raw = "---\r\ntitle: Notes\r\ntags: [a, b]\r\n---\r\n\r\n# Notes\r\n\r\n- item\r\n";
    const parts = splitDocument(raw);
    const editor = await open(parts.body);
    expect(joinDocument({ ...parts, body: editor.getMarkdown() })).toBe(raw);
  });
});

describe("minimal-diff save", () => {
  const messy = read("messy.md");

  test("an unedited document saves byte-for-byte", async () => {
    for (const name of fixtures) {
      const raw = read(name);
      expect(await saveEdited(raw, raw), name).toBe(raw);
    }
  });

  test("editing one line leaves normalizable lines elsewhere untouched", async () => {
    const edited = messy.replace("Intro paragraph.", "Intro paragraph, edited.");
    expect(await saveEdited(messy, edited)).toBe(edited);
  });

  test("appending a paragraph keeps the rest intact", async () => {
    const edited = `${messy.trimEnd()}\n\nA new closing paragraph.\n`;
    expect(await saveEdited(messy, edited)).toBe(edited);
  });

  test("adding a list item keeps the existing items' formatting", async () => {
    const edited = messy.replace("* second item\n", "* second item\n* inserted item\n");
    expect(await saveEdited(messy, edited)).toBe(edited);
  });

  test("deleting a section removes only that section", async () => {
    const edited = messy.replace(/## Remove me\n\nGone soon\.\n\n/, "");
    expect(await saveEdited(messy, edited)).toBe(edited);
  });

  test("editing inside a normalized table rewrites just that table", async () => {
    const edited = messy.replace("| 1 | 2 |", "| 1 | 3 |");
    const saved = await saveEdited(messy, edited);
    const outsideTable = (text: string) => text.replace(/\|[^\n]*\|\n/g, "");
    expect(outsideTable(saved)).toBe(outsideTable(edited));
    expect(saved).toContain("| 1    | 3     |");
  });

  test("mixed bullet markers fall back to a safe full rewrite", async () => {
    const raw = "- dash item\n\n* star list\n* two\n";
    const edited = "- dash item\n\n* star list\n* two\n* three\n";
    const saved = await saveEdited(raw, edited);
    const editor = await open(splitDocument(edited).body);
    expect(reserialize(editor, saved)).toBe(reserialize(editor, edited));
  });

  test("the merged text always parses to the edited document", async () => {
    const parts = splitDocument(messy);
    const editor = await open(parts.body);
    const edited = messy.replace("snake_case", "camelCase").replace("* first item", "* 1st item");
    const { replaceAll } = await import("@milkdown/kit/utils");
    editor.editor.action(replaceAll(splitDocument(edited).body));
    const body = bodyToSave(editor, parts.body);
    expect(reserialize(editor, body)).toBe(reserialize(editor, editor.getMarkdown()));
  });
});

describe("preserveUnchanged", () => {
  test("falls back to current lines wherever baseline lines changed", () => {
    const original = "A_b\n\n\nkeep_me\n";
    const baseline = "A\\_b\n\nkeep\\_me\n";
    const current = "A\\_b changed\n\nkeep\\_me\n";
    expect(preserveUnchanged(original, baseline, current)).toBe("A\\_b changed\n\n\nkeep_me");
  });

  test("drops original-only blank lines next to deleted content", () => {
    const original = "one\n\n\ntwo\n\nthree";
    const baseline = "one\n\ntwo\n\nthree";
    const current = "one\n\nthree";
    expect(preserveUnchanged(original, baseline, current)).toBe("one\n\nthree");
  });
});
