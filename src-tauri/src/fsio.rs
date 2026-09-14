//! File reading/writing and file-watching helpers.

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};

pub type Watcher = Debouncer<RecommendedWatcher>;

const DEBOUNCE: Duration = Duration::from_millis(150);

/// Writes `contents` via a temp file + rename so a crash never leaves a
/// half-written document. Symlinks are followed so the link itself survives.
pub fn write_atomic(path: &Path, contents: &[u8]) -> io::Result<()> {
    let target = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let dir = target
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no parent"))?;
    let name = target
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"))?;
    let tmp = dir.join(format!(".{}.gmd-tmp", name.to_string_lossy()));

    let result = (|| {
        let mut file = File::create(&tmp)?;
        file.write_all(contents)?;
        file.sync_all()?;
        drop(file);
        if let Ok(meta) = fs::metadata(&target) {
            fs::set_permissions(&tmp, meta.permissions())?;
        }
        fs::rename(&tmp, &target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Calls `on_change` whenever `path` is created, modified, replaced or removed.
///
/// Watches the parent dir rather than the file itself, because editors (and
/// `write_atomic`) replace files by rename, which orphans a direct watch.
pub fn watch_file(
    path: &Path,
    on_change: impl Fn() + Send + 'static,
) -> notify_debouncer_mini::notify::Result<Watcher> {
    let parent = path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let name = path.file_name().map(|n| n.to_os_string());
    let mut debouncer = new_debouncer(DEBOUNCE, move |res: DebounceEventResult| {
        if let Ok(events) = res {
            if events.iter().any(|e| e.path.file_name() == name.as_deref()) {
                on_change();
            }
        }
    })?;
    debouncer
        .watcher()
        .watch(&parent, RecursiveMode::NonRecursive)?;
    Ok(debouncer)
}

/// Calls `on_change` whenever anything under `dir` changes.
pub fn watch_dir(
    dir: &Path,
    on_change: impl Fn() + Send + 'static,
) -> notify_debouncer_mini::notify::Result<Watcher> {
    let mut debouncer = new_debouncer(DEBOUNCE, move |res: DebounceEventResult| {
        if res.is_ok_and(|events| !events.is_empty()) {
            on_change();
        }
    })?;
    debouncer.watcher().watch(dir, RecursiveMode::Recursive)?;
    Ok(debouncer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn atomic_write_creates_and_replaces() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        write_atomic(&path, b"one").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "one");
        write_atomic(&path, b"two").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "two");
        let leftovers: Vec<_> = fs::read_dir(dir.path()).unwrap().collect();
        assert_eq!(leftovers.len(), 1, "temp file should be renamed away");
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_keeps_symlinks_and_permissions() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real.md");
        let link = dir.path().join("link.md");
        fs::write(&real, "old").unwrap();
        fs::set_permissions(&real, fs::Permissions::from_mode(0o600)).unwrap();
        symlink(&real, &link).unwrap();

        write_atomic(&link, b"new").unwrap();

        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_to_string(&real).unwrap(), "new");
        let mode = fs::metadata(&real).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn watch_file_sees_atomic_replace_but_not_siblings() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("watched.md");
        fs::write(&path, "a").unwrap();
        let (tx, rx) = mpsc::channel();
        let _watcher = watch_file(&path, move || {
            let _ = tx.send(());
        })
        .unwrap();
        // FSEvents may replay the file's creation just after the watch starts.
        std::thread::sleep(Duration::from_millis(600));
        while rx.try_recv().is_ok() {}

        fs::write(dir.path().join("sibling.md"), "x").unwrap();
        assert!(rx.recv_timeout(Duration::from_millis(800)).is_err());

        write_atomic(&path, b"b").unwrap();
        assert!(rx.recv_timeout(Duration::from_secs(3)).is_ok());
    }
}
