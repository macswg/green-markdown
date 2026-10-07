/**
 * The window title, drawn by the page on macOS (the native title bar is
 * transparent there). Right-click the name to rename the file in place.
 */

import { Menu } from "@tauri-apps/api/menu";

export interface TitlebarOptions {
  root: HTMLElement;
  /** False for an untitled document, which has no file to rename. */
  canRename: () => boolean;
  /** Renames the file; resolves false if it failed (and was reported). */
  rename: (name: string) => Promise<boolean>;
}

export interface Titlebar {
  setTitle(name: string, dirty: boolean): void;
}

export function createTitlebar(options: TitlebarOptions): Titlebar {
  const { root } = options;
  const label = root.querySelector(".gmd-title") as HTMLElement;
  let name = "";
  let dirty = false;
  let editing = false;

  function render(): void {
    if (!editing) label.textContent = `${dirty ? "● " : ""}${name}`;
  }

  function startRename(): void {
    if (editing || !options.canRename()) return;
    editing = true;
    const input = document.createElement("input");
    input.className = "gmd-title-input";
    input.value = name;
    input.spellcheck = false;
    input.setAttribute("aria-label", "File name");
    label.replaceChildren(input);
    input.focus();
    // Like Finder: select the name but not the extension.
    const dot = name.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : name.length);

    let done = false;
    const finish = async (commit: boolean, retry = true): Promise<void> => {
      if (done) return;
      done = true;
      const next = input.value.trim();
      if (commit && next && next !== name && !(await options.rename(next)) && retry) {
        // Keep the box open so the name can be fixed.
        done = false;
        input.focus();
        return;
      }
      editing = false;
      render();
    };
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        void finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        void finish(false);
      }
    });
    // Clicking away commits, like Finder; a failed rename is dropped.
    input.addEventListener("blur", () => void finish(true, false));
  }

  root.addEventListener("contextmenu", async (event) => {
    event.preventDefault();
    if (editing) return;
    const menu = await Menu.new({
      items: [{ text: "Rename…", enabled: options.canRename(), action: startRename }],
    });
    await menu.popup();
  });

  return {
    setTitle(nextName: string, nextDirty: boolean): void {
      name = nextName;
      dirty = nextDirty;
      render();
    },
  };
}
