/**
 * Pure helpers that keep the parts of a file the editor doesn't understand
 * (BOM, line endings, front matter, trailing newlines) exactly as they were.
 */

export type Bullet = "-" | "*" | "+";

export interface DocParts {
  bom: boolean;
  eol: "\n" | "\r\n";
  /** Raw front matter block including its `---`/`+++` fences, or null. */
  frontmatter: string | null;
  /** Blank lines between the front matter and the body. */
  gap: string;
  /** Markdown body handed to the editor. */
  body: string;
  /** Newlines at the very end of the file. */
  trailing: string;
}

const FRONTMATTER =
  /^(?:---[ \t]*\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*|\+\+\+[ \t]*\n[\s\S]*?\n\+\+\+[ \t]*)(?=\n|$)/;

export function splitDocument(raw: string): DocParts {
  const bom = raw.startsWith("\uFEFF");
  let text = bom ? raw.slice(1) : raw;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  text = text.replace(/\r\n/g, "\n");

  let frontmatter: string | null = null;
  let gap = "";
  const match = FRONTMATTER.exec(text);
  if (match) {
    frontmatter = match[0];
    const rest = text.slice(frontmatter.length);
    if (rest.trim() === "") {
      return { bom, eol, frontmatter, gap, body: "", trailing: rest };
    }
    const separator = /^\n((?:[ \t]*\n)*)/.exec(rest);
    gap = separator?.[1] ?? "";
    text = rest.slice(separator?.[0].length ?? 0);
  }

  const trailing = /\n*$/.exec(text)?.[0] ?? "";
  const body = text.slice(0, text.length - trailing.length);
  return { bom, eol, frontmatter, gap, body, trailing };
}

/** Rebuilds file text from its parts; the inverse of `splitDocument`. */
export function joinDocument(parts: DocParts): string {
  const body = parts.body.replace(/\n+$/, "");
  const fm = parts.frontmatter?.trim() ? parts.frontmatter.replace(/\n+$/, "") : null;
  let text: string;
  if (fm === null) {
    text = body === "" ? "" : body + parts.trailing;
  } else {
    text = (body === "" ? fm : `${fm}\n${parts.gap}${body}`) + parts.trailing;
  }
  if (parts.eol === "\r\n") text = text.replace(/\n/g, "\r\n");
  return (parts.bom ? "\uFEFF" : "") + text;
}

/** Defaults for a brand-new document. */
export function emptyDocument(): DocParts {
  return {
    bom: false,
    eol: "\n",
    frontmatter: null,
    gap: "",
    body: "",
    trailing: "\n",
  };
}

export type Rule = "-" | "*" | "_";
export type HardBreak = "spaces" | "backslash";

/** Markdown style choices a file already makes, so saving can match them. */
export interface DocStyle {
  bullet: Bullet | null;
  rule: Rule | null;
  hardBreak: HardBreak | null;
}

/** Detects the dominant bullet, thematic break and hard-break style. */
export function detectStyle(body: string): DocStyle {
  const bullets: Record<Bullet, number> = { "-": 0, "*": 0, "+": 0 };
  const rules: Record<Rule, number> = { "-": 0, "*": 0, _: 0 };
  const breaks: Record<HardBreak, number> = { spaces: 0, backslash: 0 };
  const lines = body.split("\n");
  let fence: string | null = null;

  for (const [i, line] of lines.entries()) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (fence !== null) continue;

    const rule = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.exec(line);
    if (rule) {
      // "---" right under text is a setext heading underline, not a rule.
      const isSetext = rule[1] === "-" && i > 0 && lines[i - 1].trim() !== "";
      if (!isSetext) rules[rule[1] as Rule] += 1;
      continue;
    }
    const item = /^\s*([-*+])[ \t]+\S/.exec(line);
    if (item) bullets[item[1] as Bullet] += 1;

    const next = lines[i + 1];
    if (next !== undefined && next.trim() !== "" && line.trim() !== "") {
      if (/[^\\](?:\\\\)*\\$/.test(line)) breaks.backslash += 1;
      else if (/\S {2,}$/.test(line)) breaks.spaces += 1;
    }
  }
  return {
    bullet: mostCommon(bullets),
    rule: mostCommon(rules),
    hardBreak: mostCommon(breaks),
  };
}

function mostCommon<K extends string>(counts: Record<K, number>): K | null {
  const keys = Object.keys(counts) as K[];
  const best = keys.reduce((a, b) => (counts[b] > counts[a] ? b : a));
  return counts[best] > 0 ? best : null;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Resolves a link/image reference found in the document at `docPath`.
 * Returns an absolute filesystem path, or null for URLs and in-page anchors.
 */
export function resolveLocalPath(docPath: string | null, href: string): string | null {
  if (!href || href.startsWith("#")) return null;
  const isWindowsAbs = /^[a-z]:[\\/]/i.test(href);
  if (!isWindowsAbs && SCHEME.test(href)) {
    if (!href.toLowerCase().startsWith("file:")) return null;
    href = href.replace(/^file:\/\//i, "");
    if (/^\/[a-z]:\//i.test(href)) href = href.slice(1);
  }
  href = href.replace(/[?#].*$/, "");
  try {
    href = decodeURI(href);
  } catch {
    // Leave malformed escapes as-is.
  }

  const isAbsolute = href.startsWith("/") || isWindowsAbs || href.startsWith("\\\\");
  if (isAbsolute) return normalizePath(href);
  if (!docPath) return null;
  const sep = docPath.includes("\\") && !docPath.includes("/") ? "\\" : "/";
  const dir = docPath.replace(/[\\/][^\\/]*$/, "");
  return normalizePath(`${dir}${sep}${href}`);
}

function normalizePath(path: string): string {
  const sep = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  const parts = path.split(/[\\/]/);
  const out: string[] = [];
  for (const [i, part] of parts.entries()) {
    if (part === "." || (part === "" && i > 0 && i < parts.length - 1)) {
      continue;
    }
    if (part === ".." && out.length > 1) {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join(sep);
}

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdown|mkd|mdx)$/i.test(path);
}

/** Plain text files open in source mode without markdown highlighting. */
export function isPlainTextPath(path: string | null): boolean {
  return path !== null && /\.txt$/i.test(path);
}

/** Files the app opens from links and drag-and-drop. */
export function isOpenablePath(path: string): boolean {
  return isMarkdownPath(path) || isPlainTextPath(path);
}

export function fileName(path: string | null): string {
  if (!path) return "Untitled";
  return path.split(/[\\/]/).pop() || path;
}
