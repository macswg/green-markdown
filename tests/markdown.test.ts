import { describe, expect, test } from "vitest";
import {
  detectStyle,
  emptyDocument,
  joinDocument,
  resolveLocalPath,
  splitDocument,
} from "../src/markdown";

describe("splitDocument / joinDocument", () => {
  const cases: Record<string, string> = {
    plain: "# Hi\n\nText\n",
    "no trailing newline": "# Hi",
    "several trailing newlines": "# Hi\n\n\n",
    crlf: "# Hi\r\n\r\n- a\r\n",
    bom: "\uFEFF# Hi\n",
    "yaml front matter": "---\ntitle: X\ntags: [a]\n---\n\n# Body\n",
    "front matter without gap": "---\ntitle: X\n---\n# Body\n",
    "front matter only": "---\ntitle: X\n---\n",
    "toml front matter": "+++\ntitle = 'x'\n+++\n\nBody\n",
    "crlf front matter": "---\r\na: 1\r\n---\r\n\r\nBody\r\n",
    empty: "",
  };

  for (const [name, raw] of Object.entries(cases)) {
    test(`round-trips ${name}`, () => {
      expect(joinDocument(splitDocument(raw))).toBe(raw);
    });
  }

  test("extracts front matter and leaves a clean body", () => {
    const parts = splitDocument("---\na: 1\n---\n\n# Body\n");
    expect(parts.frontmatter).toBe("---\na: 1\n---");
    expect(parts.body).toBe("# Body");
  });

  test("a leading horizontal rule is not front matter", () => {
    const parts = splitDocument("---\n\nText\n");
    expect(parts.frontmatter).toBeNull();
  });

  test("editor output with its own trailing newline keeps the original ending", () => {
    const parts = splitDocument("# Hi");
    expect(joinDocument({ ...parts, body: "# Hi there\n" })).toBe("# Hi there");
  });

  test("clearing front matter drops it and its gap", () => {
    const parts = splitDocument("---\na: 1\n---\n\nBody\n");
    expect(joinDocument({ ...parts, frontmatter: "" })).toBe("Body\n");
  });

  test("typing a body under front matter-only file", () => {
    const parts = splitDocument("---\na: 1\n---\n");
    expect(joinDocument({ ...parts, body: "Body\n" })).toBe("---\na: 1\n---\nBody\n");
  });

  test("new documents end with a newline", () => {
    expect(joinDocument({ ...emptyDocument(), body: "Hello" })).toBe("Hello\n");
  });
});

describe("detectStyle", () => {
  test("picks the most common bullet", () => {
    expect(detectStyle("* a\n* b\n- c\n").bullet).toBe("*");
    expect(detectStyle("- a\n  + b\n- c\n").bullet).toBe("-");
  });

  test("ignores code fences, and rules are not bullets", () => {
    expect(detectStyle("```\n* not a list\n* nope\n```\n\n- real\n").bullet).toBe("-");
    expect(detectStyle("***\n\n* * *\n").bullet).toBeNull();
  });

  test("detects thematic breaks but not setext underlines", () => {
    expect(detectStyle("a\n\n---\n\nb\n\n***\n\n- - -\n").rule).toBe("-");
    expect(detectStyle("Title\n---\n\n***\n").rule).toBe("*");
  });

  test("detects hard break style", () => {
    expect(detectStyle("one  \ntwo\n").hardBreak).toBe("spaces");
    expect(detectStyle("one\\\ntwo\n").hardBreak).toBe("backslash");
    expect(detectStyle("escaped \\\\\nnot a break\n").hardBreak).toBeNull();
    expect(detectStyle("trailing  \n\nparagraph\n").hardBreak).toBeNull();
  });

  test("returns nulls for plain text", () => {
    expect(detectStyle("# Title\n\ntext")).toEqual({ bullet: null, rule: null, hardBreak: null });
  });
});

describe("resolveLocalPath", () => {
  test("resolves relative to the document", () => {
    expect(resolveLocalPath("/notes/a/doc.md", "img/x.png")).toBe("/notes/a/img/x.png");
    expect(resolveLocalPath("/notes/a/doc.md", "./x.png")).toBe("/notes/a/x.png");
    expect(resolveLocalPath("/notes/a/doc.md", "../b/other.md#part")).toBe("/notes/b/other.md");
    expect(resolveLocalPath("/notes/doc.md", "my%20file.md")).toBe("/notes/my file.md");
  });

  test("handles Windows paths", () => {
    expect(resolveLocalPath("C:\\notes\\doc.md", "img\\x.png")).toBe("C:\\notes\\img\\x.png");
    expect(resolveLocalPath("C:\\notes\\doc.md", "D:\\pics\\y.png")).toBe("D:\\pics\\y.png");
  });

  test("keeps absolute and file: paths", () => {
    expect(resolveLocalPath(null, "/abs/x.png")).toBe("/abs/x.png");
    expect(resolveLocalPath(null, "file:///abs/x.png")).toBe("/abs/x.png");
  });

  test("ignores URLs, anchors, and relative paths without a document", () => {
    expect(resolveLocalPath("/n/doc.md", "https://example.com/x.png")).toBeNull();
    expect(resolveLocalPath("/n/doc.md", "mailto:me@example.com")).toBeNull();
    expect(resolveLocalPath("/n/doc.md", "#section")).toBeNull();
    expect(resolveLocalPath(null, "x.png")).toBeNull();
  });
});
