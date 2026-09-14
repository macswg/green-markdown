//! "Check for Updates…": Tauri's updater against the public releases repo.
//! Only runs when the user picks the menu item; nothing checks in the background.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

use crate::AppState;

static RUNNING: AtomicBool = AtomicBool::new(false);

/// Starts the check on a background thread (dialogs block while shown).
pub fn start(app: &AppHandle) {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(message) = tauri::async_runtime::block_on(run(&app)) {
            progress(&app, "");
            show(&app, MessageDialogKind::Error, &message);
        }
        RUNNING.store(false, Ordering::SeqCst);
    });
}

async fn run(app: &AppHandle) -> Result<(), String> {
    progress(app, "Checking for updates…");
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| format!("Could not check for updates: {e}"))?;
    progress(app, "");

    let current = app.package_info().version.to_string();
    let Some(update) = update else {
        show(
            app,
            MessageDialogKind::Info,
            &format!("Green Markdown {current} is the latest version."),
        );
        return Ok(());
    };

    let notes = update
        .body
        .as_deref()
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .map(|b| format!("\n\n{b}"))
        .unwrap_or_default();
    let install = ask(
        app,
        &format!(
            "Green Markdown {} is available (you have {current}).{notes}",
            update.version
        ),
        "Download and Install",
    );
    if !install {
        return Ok(());
    }

    let mut received = 0usize;
    update
        .download_and_install(
            |chunk, total| {
                received += chunk;
                let text = match total {
                    Some(total) if total > 0 => {
                        format!("Downloading update… {}%", received * 100 / total as usize)
                    }
                    _ => format!("Downloading update… {} KB", received / 1024),
                };
                progress(app, &text);
            },
            || progress(app, "Installing update…"),
        )
        .await
        .map_err(|e| format!("Could not install the update: {e}"))?;
    progress(app, "");

    if ask(
        app,
        &format!(
            "Green Markdown {} is installed. Restart now to use it?",
            update.version
        ),
        "Restart",
    ) {
        let any_dirty = app
            .state::<AppState>()
            .docs
            .lock()
            .unwrap()
            .values()
            .any(|d| d.dirty);
        if any_dirty {
            // Let each window ask about its unsaved changes; the new version
            // opens next time the app is launched.
            crate::request_quit(app);
        } else {
            app.restart();
        }
    }
    Ok(())
}

/// Shows `text` in every window's banner; empty hides it.
fn progress(app: &AppHandle, text: &str) {
    let _ = app.emit("update-progress", text);
}

fn ask(app: &AppHandle, text: &str, ok: &str) -> bool {
    app.dialog()
        .message(text)
        .title("Software Update")
        .buttons(MessageDialogButtons::OkCancelCustom(
            ok.into(),
            "Later".into(),
        ))
        .blocking_show()
}

fn show(app: &AppHandle, kind: MessageDialogKind, text: &str) {
    app.dialog()
        .message(text)
        .title("Software Update")
        .kind(kind)
        .blocking_show();
}
