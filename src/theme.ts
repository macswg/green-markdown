/** Loads settings + theme CSS from the config dir and applies them. */

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import bundledSettings from "../config/settings.json?raw";
import bundledTheme from "../config/theme.css?raw";
import { type Appearance, parseSettings, type Settings } from "./settings";

interface ConfigInfo {
  dir: string | null;
  source: "env" | "repo" | "user" | "defaults";
  settings: string | null;
}

export interface LoadedConfig {
  settings: Settings;
  themeCss: string;
  warnings: string[];
}

export async function loadConfig(): Promise<LoadedConfig> {
  const info = await invoke<ConfigInfo>("get_config");
  const warnings: string[] = [];

  if (info.source === "defaults") {
    warnings.push(
      "Config folder not found — using built-in settings and theme. Set GMD_CONFIG_DIR or rebuild from the repo.",
    );
    const parsed = parseSettings(bundledSettings);
    return { settings: parsed.settings, themeCss: bundledTheme, warnings };
  }

  const parsed = parseSettings(info.settings);
  warnings.push(...parsed.warnings);

  let themeCss = bundledTheme;
  try {
    const css = await invoke<string | null>("read_config_file", { name: parsed.settings.theme });
    if (css === null) {
      warnings.push(
        `Theme "${parsed.settings.theme}" not found in ${info.dir}; using the built-in theme.`,
      );
    } else {
      themeCss = css;
    }
  } catch (e) {
    warnings.push(`${e}; using the built-in theme.`);
  }
  return { settings: parsed.settings, themeCss, warnings };
}

const themeStyle = (() => {
  const el = document.createElement("style");
  el.id = "gmd-theme";
  el.textContent = bundledTheme;
  document.head.appendChild(el);
  return el;
})();

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
let currentAppearance: Appearance = "system";

export function applyTheme(css: string): void {
  if (themeStyle.textContent !== css) themeStyle.textContent = css;
}

export function applyAppearance(appearance: Appearance): void {
  currentAppearance = appearance;
  const resolved = appearance === "system" ? (darkQuery.matches ? "dark" : "light") : appearance;
  document.documentElement.dataset.appearance = resolved;
  void getCurrentWindow()
    .setTheme(appearance === "system" ? null : appearance)
    .catch(() => {});
}

darkQuery.addEventListener("change", () => {
  if (currentAppearance === "system") applyAppearance("system");
});
