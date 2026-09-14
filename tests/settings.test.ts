import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DEFAULT_SETTINGS, parseSettings } from "../src/settings";

const repoFile = (name: string) => readFileSync(join(import.meta.dirname, "..", name), "utf8");

describe("parseSettings", () => {
  test("the repo's config/settings.json is valid and warning-free", () => {
    const { warnings } = parseSettings(repoFile("config/settings.json"));
    expect(warnings).toEqual([]);
  });

  test("the JSON schema lists exactly the settings the app understands", () => {
    const schema = JSON.parse(repoFile("settings.schema.json"));
    const topLevel = Object.keys(schema.properties).filter((k) => k !== "$schema");
    expect(topLevel.sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
    expect(Object.keys(schema.properties.editor.properties).sort()).toEqual(
      Object.keys(DEFAULT_SETTINGS.editor).sort(),
    );
  });

  test("missing or empty file gives defaults", () => {
    expect(parseSettings(null)).toEqual({ settings: DEFAULT_SETTINGS, warnings: [] });
    expect(parseSettings("  ")).toEqual({ settings: DEFAULT_SETTINGS, warnings: [] });
  });

  test("invalid JSON gives defaults and a warning", () => {
    const { settings, warnings } = parseSettings("{ nope");
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(warnings[0]).toMatch(/not valid JSON/);
  });

  test("partial settings merge over defaults", () => {
    const { settings, warnings } = parseSettings(
      JSON.stringify({ appearance: "dark", editor: { bulletChar: "*" } }),
    );
    expect(warnings).toEqual([]);
    expect(settings.appearance).toBe("dark");
    expect(settings.editor.bulletChar).toBe("*");
    expect(settings.editor.spellcheck).toBe(true);
    expect(settings.theme).toBe("theme.css");
  });

  test("bad values and unknown keys warn individually", () => {
    const { settings, warnings } = parseSettings(
      JSON.stringify({
        appearance: "purple",
        fontSize: 20,
        editor: { spellcheck: "yes", bulletChar: "-", colour: 1 },
      }),
    );
    expect(settings.appearance).toBe("system");
    expect(settings.editor.spellcheck).toBe(true);
    expect(settings.editor.bulletChar).toBe("-");
    expect(warnings).toHaveLength(4);
    expect(warnings.join("\n")).toMatch(/"appearance".*purple/);
    expect(warnings.join("\n")).toMatch(/Unknown setting "fontSize"/);
    expect(warnings.join("\n")).toMatch(/"editor.spellcheck"/);
    expect(warnings.join("\n")).toMatch(/Unknown setting "editor.colour"/);
  });

  test("defaults are not mutated between parses", () => {
    parseSettings(JSON.stringify({ editor: { placeholder: "x" } }));
    expect(DEFAULT_SETTINGS.editor.placeholder).toBe("Start writing…");
  });
});
