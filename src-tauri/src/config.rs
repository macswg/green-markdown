//! Locating the config dir (settings.json + theme CSS).

use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};

/// Where the active config dir came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// `GMD_CONFIG_DIR` environment variable.
    Env,
    /// The repo checkout the app was built from.
    Repo,
    /// No config dir found; the frontend uses its bundled defaults.
    Defaults,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Env => "env",
            Source::Repo => "repo",
            Source::Defaults => "defaults",
        }
    }
}

/// Resolves the config dir: `GMD_CONFIG_DIR`, then the build-time repo path.
pub fn resolve(env_value: Option<OsString>, repo_dir: &Path) -> (Option<PathBuf>, Source) {
    if let Some(value) = env_value.filter(|v| !v.is_empty()) {
        let dir = PathBuf::from(value);
        if dir.is_dir() {
            return (Some(dir), Source::Env);
        }
    }
    if repo_dir.is_dir() {
        return (Some(repo_dir.to_path_buf()), Source::Repo);
    }
    (None, Source::Defaults)
}

/// The config dir for this process.
pub fn current() -> (Option<PathBuf>, Source) {
    resolve(
        std::env::var_os("GMD_CONFIG_DIR"),
        Path::new(env!("GMD_REPO_CONFIG_DIR")),
    )
}

/// Joins a config-relative file name, refusing anything that escapes the dir.
pub fn join_relative(dir: &Path, name: &str) -> Option<PathBuf> {
    let rel = Path::new(name);
    let safe = !name.is_empty() && rel.components().all(|c| matches!(c, Component::Normal(_)));
    safe.then(|| dir.join(rel))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_dir_wins_when_it_exists() {
        let env_dir = tempfile::tempdir().unwrap();
        let repo_dir = tempfile::tempdir().unwrap();
        let (dir, source) = resolve(Some(env_dir.path().into()), repo_dir.path());
        assert_eq!(dir.as_deref(), Some(env_dir.path()));
        assert_eq!(source, Source::Env);
    }

    #[test]
    fn missing_env_dir_falls_back_to_repo() {
        let repo_dir = tempfile::tempdir().unwrap();
        let (dir, source) = resolve(Some("/definitely/not/here".into()), repo_dir.path());
        assert_eq!(dir.as_deref(), Some(repo_dir.path()));
        assert_eq!(source, Source::Repo);
    }

    #[test]
    fn nothing_found_means_defaults() {
        let (dir, source) = resolve(None, Path::new("/definitely/not/here"));
        assert_eq!(dir, None);
        assert_eq!(source, Source::Defaults);
    }

    #[test]
    fn join_relative_rejects_escapes() {
        let dir = Path::new("/cfg");
        assert_eq!(
            join_relative(dir, "themes/serif.css"),
            Some(PathBuf::from("/cfg/themes/serif.css"))
        );
        assert_eq!(join_relative(dir, "../secret.css"), None);
        assert_eq!(join_relative(dir, "/etc/passwd"), None);
        assert_eq!(join_relative(dir, "./theme.css"), None);
        assert_eq!(join_relative(dir, ""), None);
    }
}
