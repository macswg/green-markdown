/**
 * settings.json parsing. Every value is validated individually so one typo
 * produces a warning and a default, never a broken window.
 * Keep in sync with settings.schema.json and the md-style skill.
 */

export type Appearance = "system" | "light" | "dark";

export interface EditorSettings {
  spellcheck: boolean;
  /** "auto" reuses the marker most common in the file. */
  bulletChar: "auto" | "-" | "*" | "+";
  /** "auto" reuses the style already in the file. */
  hardBreak: "auto" | "spaces" | "backslash";
  blockHandle: boolean;
  selectionToolbar: boolean;
  placeholder: string;
}

export interface Settings {
  theme: string;
  appearance: Appearance;
  editor: EditorSettings;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "theme.css",
  appearance: "system",
  editor: {
    spellcheck: true,
    bulletChar: "auto",
    hardBreak: "auto",
    blockHandle: true,
    selectionToolbar: true,
    placeholder: "Start writing…",
  },
};

type Check = (value: unknown) => boolean;

const oneOf =
  (...options: string[]): Check =>
  (v) =>
    typeof v === "string" && options.includes(v);
const isBool: Check = (v) => typeof v === "boolean";
const isString: Check = (v) => typeof v === "string";
const describeOptions = (check: Check, fallback: unknown) =>
  check === isBool
    ? "true or false"
    : check === isString
      ? "a string"
      : `e.g. ${JSON.stringify(fallback)}`;

const TOP_LEVEL: Record<string, Check> = {
  theme: (v) => typeof v === "string" && v.trim() !== "",
  appearance: oneOf("system", "light", "dark"),
};

const EDITOR: Record<keyof EditorSettings, Check> = {
  spellcheck: isBool,
  bulletChar: oneOf("auto", "-", "*", "+"),
  hardBreak: oneOf("auto", "spaces", "backslash"),
  blockHandle: isBool,
  selectionToolbar: isBool,
  placeholder: isString,
};

export interface ParsedSettings {
  settings: Settings;
  warnings: string[];
}

export function parseSettings(text: string | null | undefined): ParsedSettings {
  const settings: Settings = structuredClone(DEFAULT_SETTINGS);
  const warnings: string[] = [];
  if (text == null || text.trim() === "") return { settings, warnings };

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    warnings.push(`settings.json is not valid JSON (${(e as Error).message}); using defaults.`);
    return { settings, warnings };
  }
  if (!isPlainObject(raw)) {
    warnings.push("settings.json must contain a JSON object; using defaults.");
    return { settings, warnings };
  }

  for (const [key, value] of Object.entries(raw)) {
    if (key === "$schema") continue;
    if (key === "editor") {
      if (!isPlainObject(value)) {
        warnings.push('"editor" must be an object; using default editor settings.');
        continue;
      }
      for (const [editorKey, editorValue] of Object.entries(value)) {
        const check = EDITOR[editorKey as keyof EditorSettings];
        if (!check) {
          warnings.push(`Unknown setting "editor.${editorKey}" was ignored.`);
        } else if (!check(editorValue)) {
          const fallback = DEFAULT_SETTINGS.editor[editorKey as keyof EditorSettings];
          warnings.push(
            `"editor.${editorKey}" has an invalid value ${JSON.stringify(editorValue)} (${describeOptions(check, fallback)}); using ${JSON.stringify(fallback)}.`,
          );
        } else {
          (settings.editor as unknown as Record<string, unknown>)[editorKey] = editorValue;
        }
      }
      continue;
    }
    const check = TOP_LEVEL[key];
    if (!check) {
      warnings.push(`Unknown setting "${key}" was ignored.`);
    } else if (!check(value)) {
      const fallback = (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[key];
      warnings.push(
        `"${key}" has an invalid value ${JSON.stringify(value)}; using ${JSON.stringify(fallback)}.`,
      );
    } else {
      (settings as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return { settings, warnings };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
