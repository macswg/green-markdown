//! Green Markdown: a thin Tauri shell. One window per document; the frontend
//! owns editing, this side owns files, watchers, windows and menus.

mod config;
mod fsio;
mod update;
mod zoom;

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, RunEvent, State, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

const MARKDOWN_EXTENSIONS: &[&str] = &["md", "markdown", "mdown", "mkd", "mdx", "txt"];
const DEFAULT_SIZE: (f64, f64) = (900.0, 1000.0);
const CASCADE_OFFSET: f64 = 28.0;

static WINDOW_COUNTER: AtomicUsize = AtomicUsize::new(1);

#[derive(Default)]
pub(crate) struct Doc {
    path: Option<PathBuf>,
    pub(crate) dirty: bool,
    watcher: Option<fsio::Watcher>,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
struct Geometry {
    width: f64,
    height: f64,
    x: f64,
    y: f64,
}

#[derive(Default)]
pub(crate) struct AppState {
    pub(crate) docs: Mutex<HashMap<String, Doc>>,
    geometry: Mutex<Option<Geometry>>,
    config_watcher: Mutex<Option<fsio::Watcher>>,
    pub(crate) zoom: zoom::Zoom,
}

#[derive(Serialize)]
struct ConfigInfo {
    dir: Option<String>,
    source: &'static str,
    settings: Option<String>,
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_window_path(window: WebviewWindow, state: State<AppState>) -> Option<String> {
    let docs = state.docs.lock().unwrap();
    docs.get(window.label())
        .and_then(|d| d.path.as_ref())
        .map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
fn set_window_path(window: WebviewWindow, path: String) {
    attach_path(window.app_handle(), window.label(), PathBuf::from(path));
}

#[tauri::command]
fn set_dirty(window: WebviewWindow, state: State<AppState>, dirty: bool) {
    if let Some(doc) = state.docs.lock().unwrap().get_mut(window.label()) {
        doc.dirty = dirty;
    }
}

/// Errors starting with "not-found" mean the file is gone (moved or deleted).
#[tauri::command]
fn read_text(path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => format!("not-found: {path}"),
        _ => format!("could not read {path}: {e}"),
    })?;
    String::from_utf8(bytes).map_err(|_| format!("{path} is not valid UTF-8 text"))
}

#[tauri::command]
fn write_text(path: String, contents: String) -> Result<(), String> {
    fsio::write_atomic(Path::new(&path), contents.as_bytes())
        .map_err(|e| format!("could not save {path}: {e}"))
}

#[tauri::command]
fn get_config() -> ConfigInfo {
    let (dir, source) = config::current();
    let settings = dir
        .as_ref()
        .and_then(|d| fs::read_to_string(d.join("settings.json")).ok());
    ConfigInfo {
        dir: dir.map(|d| d.to_string_lossy().into_owned()),
        source: source.as_str(),
        settings,
    }
}

/// Reads a file inside the config dir; `Ok(None)` if it doesn't exist.
#[tauri::command]
fn read_config_file(name: String) -> Result<Option<String>, String> {
    let (Some(dir), _) = config::current() else {
        return Ok(None);
    };
    let path = config::join_relative(&dir, &name)
        .ok_or_else(|| format!("\"{name}\" must be a relative path inside the config dir"))?;
    match fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("could not read {}: {e}", path.display())),
    }
}

/// Development aid: webview errors and lifecycle notes, printed to the terminal.
#[tauri::command]
fn dev_log(window: WebviewWindow, message: String) {
    eprintln!("[{}] {message}", window.label());
}

/// Opens each path in a window. The first may reuse the `reuse` window if it
/// is an untouched untitled document.
#[tauri::command]
async fn open_paths(app: AppHandle, paths: Vec<String>, reuse: Option<String>) {
    open_all(&app, paths.into_iter().map(PathBuf::from), reuse);
}

// ---------------------------------------------------------------------------
// Windows and documents
// ---------------------------------------------------------------------------

fn attach_path(app: &AppHandle, label: &str, path: PathBuf) {
    let path = fs::canonicalize(&path).unwrap_or(path);
    let emit_app = app.clone();
    let emit_label = label.to_string();
    let watcher = fsio::watch_file(&path, move || {
        let _ = emit_app.emit_to(emit_label.as_str(), "file-changed", ());
    })
    .map_err(|e| eprintln!("gmd: cannot watch {}: {e}", path.display()))
    .ok();

    let state = app.state::<AppState>();
    let mut docs = state.docs.lock().unwrap();
    let doc = docs.entry(label.to_string()).or_default();
    doc.path = Some(path);
    doc.watcher = watcher;
}

fn open_all(app: &AppHandle, paths: impl IntoIterator<Item = PathBuf>, mut reuse: Option<String>) {
    for path in paths {
        open_path(app, path, reuse.take());
    }
}

fn open_path(app: &AppHandle, path: PathBuf, reuse: Option<String>) {
    let path = fs::canonicalize(&path).unwrap_or(path);
    let state = app.state::<AppState>();

    let (existing, reusable) = {
        let docs = state.docs.lock().unwrap();
        let existing = docs
            .iter()
            .find(|(_, d)| d.path.as_deref() == Some(path.as_path()))
            .map(|(label, _)| label.clone());
        let reusable = reuse.filter(|label| {
            docs.get(label)
                .is_some_and(|d| d.path.is_none() && !d.dirty)
        });
        (existing, reusable)
    };

    if let Some(window) = existing.and_then(|l| app.get_webview_window(&l)) {
        let _ = window.unminimize();
        let _ = window.set_focus();
        return;
    }
    if let Some(label) = reusable {
        attach_path(app, &label, path);
        let _ = app.emit_to(label.as_str(), "load-file", ());
        return;
    }
    if let Err(e) = create_doc_window(app, Some(path)) {
        eprintln!("gmd: could not open window: {e}");
    }
}

fn create_doc_window(app: &AppHandle, path: Option<PathBuf>) -> tauri::Result<WebviewWindow> {
    let label = format!("doc-{}", WINDOW_COUNTER.fetch_add(1, Ordering::SeqCst));
    let title = path
        .as_ref()
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Untitled".into());

    let state = app.state::<AppState>();
    state
        .docs
        .lock()
        .unwrap()
        .insert(label.clone(), Doc::default());
    if let Some(path) = path {
        attach_path(app, &label, path);
    }

    let has_windows = !app.webview_windows().is_empty();
    let saved = *state.geometry.lock().unwrap();
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title(title)
        .min_inner_size(420.0, 320.0);
    match saved {
        Some(g) => {
            let offset = if has_windows { CASCADE_OFFSET } else { 0.0 };
            builder = builder.inner_size(g.width, g.height);
            if position_is_visible(app, g.x + offset, g.y + offset) {
                builder = builder.position(g.x + offset, g.y + offset);
            }
        }
        None => builder = builder.inner_size(DEFAULT_SIZE.0, DEFAULT_SIZE.1),
    }

    let window = builder.build();
    match &window {
        Ok(w) => zoom::apply(w),
        Err(_) => {
            state.docs.lock().unwrap().remove(&label);
        }
    }
    window
}

fn position_is_visible(app: &AppHandle, x: f64, y: f64) -> bool {
    let Ok(monitors) = app.available_monitors() else {
        return false;
    };
    monitors.iter().any(|m| {
        let scale = m.scale_factor();
        let pos: LogicalPosition<f64> = m.position().to_logical(scale);
        let size: LogicalSize<f64> = m.size().to_logical(scale);
        // Require the top-left corner (plus some title bar) to be on screen.
        x + 60.0 >= pos.x
            && x + 60.0 <= pos.x + size.width
            && y >= pos.y
            && y + 40.0 <= pos.y + size.height
    })
}

fn geometry_file(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("window.json"))
}

fn load_geometry(app: &AppHandle) -> Option<Geometry> {
    let text = fs::read_to_string(geometry_file(app)?).ok()?;
    serde_json::from_str(&text).ok()
}

fn save_geometry(app: &AppHandle) {
    let Some(geometry) = *app.state::<AppState>().geometry.lock().unwrap() else {
        return;
    };
    if let (Some(file), Ok(json)) = (geometry_file(app), serde_json::to_string(&geometry)) {
        if let Some(dir) = file.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = fs::write(file, json);
    }
}

fn record_geometry(window: &tauri::Window) {
    if window.is_minimized().unwrap_or(true)
        || window.is_fullscreen().unwrap_or(true)
        || window.is_maximized().unwrap_or(true)
    {
        return;
    }
    let (Ok(scale), Ok(size), Ok(pos)) = (
        window.scale_factor(),
        window.inner_size(),
        window.outer_position(),
    ) else {
        return;
    };
    let size: LogicalSize<f64> = size.to_logical(scale);
    let pos: LogicalPosition<f64> = pos.to_logical(scale);
    *window.state::<AppState>().geometry.lock().unwrap() = Some(Geometry {
        width: size.width,
        height: size.height,
        x: pos.x,
        y: pos.y,
    });
}

fn focused_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.webview_windows()
        .into_values()
        .find(|w| w.is_focused().unwrap_or(false))
}

/// Quits right away if nothing is unsaved; otherwise asks every window to
/// close so dirty ones can prompt (the app exits when the last one closes).
pub(crate) fn request_quit(app: &AppHandle) {
    let any_dirty = app
        .state::<AppState>()
        .docs
        .lock()
        .unwrap()
        .values()
        .any(|d| d.dirty);
    if !any_dirty {
        save_geometry(app);
        app.exit(0);
        return;
    }
    for window in app.webview_windows().values() {
        let _ = window.close();
    }
}

/// Turns command-line arguments into absolute file paths.
fn cli_paths(args: impl IntoIterator<Item = String>, cwd: Option<&Path>) -> Vec<PathBuf> {
    args.into_iter()
        .filter(|a| !a.is_empty() && !a.starts_with('-'))
        .map(PathBuf::from)
        .map(|p| match cwd {
            Some(cwd) if p.is_relative() => cwd.join(p),
            _ => p,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let new = MenuItem::with_id(app, "new", "New", true, Some("CmdOrCtrl+N"))?;
    let open = MenuItem::with_id(app, "open", "Open…", true, Some("CmdOrCtrl+O"))?;
    let save = MenuItem::with_id(app, "save", "Save", true, Some("CmdOrCtrl+S"))?;
    let save_as = MenuItem::with_id(app, "save_as", "Save As…", true, Some("CmdOrCtrl+Shift+S"))?;
    let close = MenuItem::with_id(app, "close", "Close Window", true, Some("CmdOrCtrl+W"))?;
    let config_dir =
        MenuItem::with_id(app, "config_dir", "Open Config Folder", true, None::<&str>)?;
    let quit = MenuItem::with_id(
        app,
        "quit",
        "Quit Green Markdown",
        true,
        Some("CmdOrCtrl+Q"),
    )?;
    let sep = || PredefinedMenuItem::separator(app);
    let update = MenuItem::with_id(app, "update", "Check for Updates…", true, None::<&str>)?;
    let about = || {
        PredefinedMenuItem::about(
            app,
            None,
            Some(AboutMetadata {
                authors: Some(vec!["Sean W. Green".into()]),
                copyright: Some("© Sean W. Green".into()),
                ..Default::default()
            }),
        )
    };

    let find = MenuItem::with_id(app, "find", "Find…", true, Some("CmdOrCtrl+F"))?;
    let find_next = MenuItem::with_id(app, "find_next", "Find Next", true, Some("CmdOrCtrl+G"))?;
    let find_prev = MenuItem::with_id(
        app,
        "find_prev",
        "Find Previous",
        true,
        Some("CmdOrCtrl+Shift+G"),
    )?;
    let outline = MenuItem::with_id(
        app,
        "toggle_outline",
        "Toggle Outline",
        true,
        Some("CmdOrCtrl+Shift+O"),
    )?;
    let source = MenuItem::with_id(
        app,
        "toggle_source",
        "Toggle Source Mode",
        true,
        Some("CmdOrCtrl+/"),
    )?;
    let line_numbers = MenuItem::with_id(
        app,
        "toggle_line_numbers",
        "Toggle Line Numbers",
        true,
        Some("CmdOrCtrl+Shift+L"),
    )?;

    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &sep()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
            &sep()?,
            &find,
            &find_next,
            &find_prev,
        ],
    )?;
    let zoom_in = MenuItem::with_id(app, "zoom_in", "Zoom In", true, Some("CmdOrCtrl+="))?;
    let zoom_out = MenuItem::with_id(app, "zoom_out", "Zoom Out", true, Some("CmdOrCtrl+-"))?;
    let zoom_reset =
        MenuItem::with_id(app, "zoom_reset", "Actual Size", true, Some("CmdOrCtrl+0"))?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &outline,
            &source,
            &line_numbers,
            &sep()?,
            &zoom_in,
            &zoom_out,
            &zoom_reset,
        ],
    )?;

    #[cfg(target_os = "macos")]
    {
        let app_menu = Submenu::with_items(
            app,
            "Green Markdown",
            true,
            &[
                &about()?,
                &update,
                &sep()?,
                &config_dir,
                &sep()?,
                &PredefinedMenuItem::services(app, None)?,
                &sep()?,
                &PredefinedMenuItem::hide(app, None)?,
                &PredefinedMenuItem::hide_others(app, None)?,
                &PredefinedMenuItem::show_all(app, None)?,
                &sep()?,
                &quit,
            ],
        )?;
        let file = Submenu::with_items(
            app,
            "File",
            true,
            &[&new, &open, &sep()?, &save, &save_as, &sep()?, &close],
        )?;
        let window = Submenu::with_items(
            app,
            "Window",
            true,
            &[
                &PredefinedMenuItem::minimize(app, None)?,
                &PredefinedMenuItem::maximize(app, None)?,
                &PredefinedMenuItem::fullscreen(app, None)?,
            ],
        )?;
        Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window])
    }

    #[cfg(not(target_os = "macos"))]
    {
        let file = Submenu::with_items(
            app,
            "File",
            true,
            &[
                &new,
                &open,
                &sep()?,
                &save,
                &save_as,
                &sep()?,
                &config_dir,
                &sep()?,
                &close,
                &quit,
            ],
        )?;
        let help = Submenu::with_items(app, "Help", true, &[&about()?, &update])?;
        Menu::with_items(app, &[&file, &edit, &view, &help])
    }
}

fn handle_menu(app: &AppHandle, id: &str) {
    if zoom::handle_menu(app, id) {
        return;
    }
    match id {
        "new" => {
            let _ = create_doc_window(app, None);
        }
        "open" => {
            let reuse = focused_window(app).map(|w| w.label().to_string());
            let handle = app.clone();
            app.dialog()
                .file()
                .add_filter("Markdown & Text", MARKDOWN_EXTENSIONS)
                .pick_files(move |picked| {
                    let paths = picked
                        .unwrap_or_default()
                        .into_iter()
                        .filter_map(|p| p.into_path().ok());
                    open_all(&handle, paths, reuse);
                });
        }
        "save"
        | "save_as"
        | "find"
        | "find_next"
        | "find_prev"
        | "toggle_outline"
        | "toggle_source"
        | "toggle_line_numbers" => {
            if let Some(window) = focused_window(app) {
                let _ = window.emit_to(window.label(), "menu", id);
            }
        }
        "close" => {
            if let Some(window) = focused_window(app) {
                let _ = window.close();
            }
        }
        "config_dir" => {
            if let (Some(dir), _) = config::current() {
                let _ = app.opener().open_path(dir.to_string_lossy(), None::<&str>);
            }
        }
        "quit" => request_quit(app),
        "update" => update::start(app),
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// App entry point
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let paths = cli_paths(argv.into_iter().skip(1), Some(Path::new(&cwd)));
            if paths.is_empty() {
                let _ = create_doc_window(app, None);
            } else {
                open_all(app, paths, None);
            }
        }));
    }

    let app = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            get_window_path,
            set_window_path,
            set_dirty,
            read_text,
            write_text,
            get_config,
            read_config_file,
            open_paths,
            dev_log,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            *app.state::<AppState>().geometry.lock().unwrap() = load_geometry(&handle);
            zoom::load(&handle);

            app.set_menu(build_menu(&handle)?)?;
            app.on_menu_event(|app, event| handle_menu(app, event.id().as_ref()));

            if let (Some(dir), _) = config::current() {
                let emit_handle = handle.clone();
                let watcher = fsio::watch_dir(&dir, move || {
                    let _ = emit_handle.emit("config-changed", ());
                });
                match watcher {
                    Ok(w) => *app.state::<AppState>().config_watcher.lock().unwrap() = Some(w),
                    Err(e) => eprintln!("gmd: cannot watch config dir {}: {e}", dir.display()),
                }
            }

            let cwd = std::env::current_dir().ok();
            let paths = cli_paths(std::env::args().skip(1), cwd.as_deref());
            if !paths.is_empty() {
                open_all(&handle, paths, None);
            } else if cfg!(target_os = "macos") {
                // Finder launches deliver files via RunEvent::Opened shortly
                // after startup; only show an untitled window if none arrive.
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(400));
                    if handle.webview_windows().is_empty() {
                        let _ = create_doc_window(&handle, None);
                    }
                });
            } else {
                create_doc_window(&handle, None)?;
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::Moved(_) | WindowEvent::Resized(_) => record_geometry(window),
            WindowEvent::Destroyed => {
                let app = window.app_handle();
                app.state::<AppState>()
                    .docs
                    .lock()
                    .unwrap()
                    .remove(window.label());
                save_geometry(app);
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| match event {
        #[cfg(target_os = "macos")]
        RunEvent::Opened { urls } => {
            let paths = urls.into_iter().filter_map(|u| u.to_file_path().ok());
            open_all(app, paths, None);
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } => {
            if app.webview_windows().is_empty() {
                let _ = create_doc_window(app, None);
            }
        }
        RunEvent::ExitRequested {
            code: None, api, ..
        } => {
            let any_dirty = app
                .state::<AppState>()
                .docs
                .lock()
                .unwrap()
                .values()
                .any(|d| d.dirty);
            if any_dirty {
                api.prevent_exit();
                request_quit(app);
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_paths_skips_flags_and_resolves_relative() {
        let cwd = Path::new("/work");
        let args = ["-psn_0_123", "notes.md", "/abs/readme.md", ""].map(String::from);
        assert_eq!(
            cli_paths(args, Some(cwd)),
            vec![
                PathBuf::from("/work/notes.md"),
                PathBuf::from("/abs/readme.md")
            ]
        );
    }
}
