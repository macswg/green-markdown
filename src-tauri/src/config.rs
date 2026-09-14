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
    /// The per-user app config dir, seeded with the built-in defaults.
    User,
    /// No config dir found; the frontend uses its bundled defaults.
    Defaults,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Env => "env",
            Source::Repo => "repo",
            Source::User => "user",
            Source::Defaults => "defaults",
        }
    }
}

/// Resolves the config dir: `GMD_CONFIG_DIR`, then the build-time repo path,
/// then the per-user dir (when it exists).
pub fn resolve(
    env_value: Option<OsString>,
    repo_dir: &Path,
    user_dir: Option<&Path>,
) -> (Option<PathBuf>, Source) {
    if let Some(value) = env_value.filter(|v| !v.is_empty()) {
        let dir = PathBuf::from(value);
        if dir.is_dir() {
            return (Some(dir), Source::Env);
        }
    }
    if repo_dir.is_dir() {
        return (Some(repo_dir.to_path_buf()), Source::Repo);
    }
    if let Some(user_dir) = user_dir.filter(|d| d.is_dir()) {
        return (Some(user_dir.to_path_buf()), Source::User);
    }
    (None, Source::Defaults)
}

const DEFAULT_SETTINGS: &str = include_str!("../../config/settings.json");
const DEFAULT_THEME: &str = include_str!("../../config/theme.css");

/// `<OS config dir>/Green Markdown/config`, e.g. `~/Library/Application Support/…`.
fn user_dir() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("Green Markdown").join("config"))
}

/// Creates `dir` with the built-in settings and theme if it doesn't exist yet.
pub fn seed(dir: &Path) -> std::io::Result<()> {
    if dir.is_dir() {
        return Ok(());
    }
    std::fs::create_dir_all(dir)?;
    // The repo copy points `$schema` at a file that isn't shipped with the app.
    let settings = DEFAULT_SETTINGS.replace("  \"$schema\": \"../settings.schema.json\",\n", "");
    std::fs::write(dir.join("settings.json"), settings)?;
    std::fs::write(dir.join("theme.css"), DEFAULT_THEME)
}

/// The config dir for this process.
pub fn current() -> (Option<PathBuf>, Source) {
    let env_value = std::env::var_os("GMD_CONFIG_DIR");
    let repo_dir = Path::new(env!("GMD_REPO_CONFIG_DIR"));
    let found = resolve(env_value.clone(), repo_dir, None);
    if found.1 != Source::Defaults {
        return found;
    }
    let user = user_dir();
    if let Some(dir) = &user {
        if let Err(e) = seed(dir) {
            eprintln!("gmd: cannot create config dir {}: {e}", dir.display());
        }
    }
    resolve(env_value, repo_dir, user.as_deref())
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
        let (dir, source) = resolve(Some(env_dir.path().into()), repo_dir.path(), None);
        assert_eq!(dir.as_deref(), Some(env_dir.path()));
        assert_eq!(source, Source::Env);
    }

    #[test]
    fn missing_env_dir_falls_back_to_repo() {
        let repo_dir = tempfile::tempdir().unwrap();
        let (dir, source) = resolve(Some("/definitely/not/here".into()), repo_dir.path(), None);
        assert_eq!(dir.as_deref(), Some(repo_dir.path()));
        assert_eq!(source, Source::Repo);
    }

    #[test]
    fn nothing_found_means_defaults() {
        let (dir, source) = resolve(None, Path::new("/definitely/not/here"), None);
        assert_eq!(dir, None);
        assert_eq!(source, Source::Defaults);
    }

    #[test]
    fn missing_repo_falls_back_to_seeded_user_dir() {
        let base = tempfile::tempdir().unwrap();
        let user = base.path().join("Green Markdown/config");
        seed(&user).unwrap();
        let settings = std::fs::read_to_string(user.join("settings.json")).unwrap();
        assert!(!settings.contains("$schema"));
        assert!(serde_json::from_str::<serde_json::Value>(&settings).is_ok());
        assert!(user.join("theme.css").is_file());

        let (dir, source) = resolve(None, Path::new("/definitely/not/here"), Some(&user));
        assert_eq!(dir.as_deref(), Some(user.as_path()));
        assert_eq!(source, Source::User);
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
