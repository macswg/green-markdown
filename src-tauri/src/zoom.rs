//! Page zoom (⌘+ / ⌘- / ⌘0): scales the whole webview, shared by every
//! window and remembered across launches.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, Manager, WebviewWindow};

use crate::AppState;

/// Zoom stops, matching the browser-style steps people expect.
const LEVELS: &[f64] = &[
    0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0,
];

pub(crate) struct Zoom(pub(crate) Mutex<f64>);

impl Default for Zoom {
    fn default() -> Self {
        Zoom(Mutex::new(1.0))
    }
}

/// The next stop above (`direction` > 0) or below `current`.
fn step(current: f64, direction: i32) -> f64 {
    let next = if direction > 0 {
        LEVELS.iter().find(|&&l| l > current + 0.001)
    } else {
        LEVELS.iter().rev().find(|&&l| l < current - 0.001)
    };
    next.copied().unwrap_or(current)
}

fn zoom_file(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("zoom.json"))
}

pub(crate) fn load(app: &AppHandle) {
    let level = zoom_file(app)
        .and_then(|f| fs::read_to_string(f).ok())
        .and_then(|t| t.trim().parse::<f64>().ok())
        .filter(|l| (LEVELS[0]..=LEVELS[LEVELS.len() - 1]).contains(l))
        .unwrap_or(1.0);
    *app.state::<AppState>().zoom.0.lock().unwrap() = level;
}

fn save(app: &AppHandle, level: f64) {
    if let Some(file) = zoom_file(app) {
        if let Some(dir) = file.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = fs::write(file, level.to_string());
    }
}

/// Applies the current zoom to a newly created window.
pub(crate) fn apply(window: &WebviewWindow) {
    let level = *window.state::<AppState>().zoom.0.lock().unwrap();
    let _ = window.set_zoom(level);
}

/// Handles the zoom menu items; returns false for other ids.
pub(crate) fn handle_menu(app: &AppHandle, id: &str) -> bool {
    let state = app.state::<AppState>();
    let mut current = state.zoom.0.lock().unwrap();
    let level = match id {
        "zoom_in" => step(*current, 1),
        "zoom_out" => step(*current, -1),
        "zoom_reset" => 1.0,
        _ => return false,
    };
    *current = level;
    drop(current);
    for window in app.webview_windows().values() {
        let _ = window.set_zoom(level);
    }
    save(app, level);
    true
}

#[cfg(test)]
mod tests {
    use super::step;

    #[test]
    fn steps_between_levels() {
        assert_eq!(step(1.0, 1), 1.1);
        assert_eq!(step(1.0, -1), 0.9);
        assert_eq!(step(1.05, 1), 1.1);
        assert_eq!(step(1.05, -1), 1.0);
    }

    #[test]
    fn clamps_at_the_ends() {
        assert_eq!(step(3.0, 1), 3.0);
        assert_eq!(step(0.5, -1), 0.5);
    }
}
