import { afterEach, describe, expect, test } from "vitest";
import { editorViewCtx } from "@milkdown/kit/core";
import { bodyToSave, createEditor, type Editor, reserialize, resolveStyle } from "../src/editor";
import { detectStyle, joinDocument, splitDocument } from "../src/markdown";
import { DEFAULT_SETTINGS } from "../src/settings";

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

const types = (editor: Editor) =>
  editor.editor.action((ctx) => {
    const names: string[] = [];
    ctx.get(editorViewCtx).state.doc.descendants((node) => void names.push(node.type.name));
    return names;
  });

describe("details", () => {
  const cases = {
    basic: "<details>\n<summary>Title</summary>\n\nBody **bold**\n\n- a\n\n</details>\n\nafter\n",
    open: "<details open>\n<summary>Title <b>x</b></summary>\n\nBody\n\n</details>\n",
    nested:
      "<details>\n<summary>Outer</summary>\n\n<details>\n<summary>Inner</summary>\n\nDeep\n\n</details>\n\n</details>\n",
    split: "<details>\n\n<summary>Title</summary>\n\nBody\n\n</details>\n",
  };

  for (const [name, md] of Object.entries(cases)) {
    test(`${name} becomes a details node and round-trips`, async () => {
      const editor = await open(md);
      expect(types(editor)).toContain("details");
      expect(reserialize(editor, md)).toBe(md);
    });
  }

  test("nested blocks nest", async () => {
    const editor = await open(cases.nested);
    expect(types(editor).filter((t) => t === "details")).toHaveLength(2);
  });

  test("unclosed and single-line forms stay raw HTML", async () => {
    for (const md of [
      "<details>\n<summary>Title</summary>\n\nno close\n",
      "<details><summary>One</summary>inline</details>\n",
    ]) {
      const editor = await open(md);
      expect(types(editor)).not.toContain("details");
      expect(reserialize(editor, md)).toBe(md);
    }
  });

  test("renders a native details element with the summary text", async () => {
    const editor = await open(cases.open);
    const root = editor.editor.action((ctx) => ctx.get(editorViewCtx).dom);
    const el = root.querySelector("details.gmd-details") as HTMLDetailsElement;
    expect(el.open).toBe(true);
    expect((el.querySelector("input") as HTMLInputElement).value).toBe("Title x");
  });

  test("editing the summary rewrites only the opening tag", async () => {
    const editor = await open(cases.open);
    const root = editor.editor.action((ctx) => ctx.get(editorViewCtx).dom);
    const input = root.querySelector("details input") as HTMLInputElement;
    input.value = "New <title>";
    input.dispatchEvent(new Event("change"));
    const parts = splitDocument(cases.open);
    expect(joinDocument({ ...parts, body: bodyToSave(editor, parts.body) })).toBe(
      "<details open>\n<summary>New &lt;title&gt;</summary>\n\nBody\n\n</details>\n",
    );
  });
});
