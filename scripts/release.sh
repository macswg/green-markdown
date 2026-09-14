#!/usr/bin/env bash
# Bumps the version everywhere, commits, tags v<version> and pushes.
# GitHub Actions then builds and publishes the release that installed apps
# pick up via "Check for Updates…".
#
# Usage: scripts/release.sh 0.2.0 ["Release notes"]
set -euo pipefail

version="${1:?usage: scripts/release.sh <version> [notes]}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "version must be X.Y.Z" >&2; exit 1; }
cd "$(dirname "$0")/.."

if [[ -n "$(git status --porcelain)" ]]; then
  echo "There are uncommitted changes; commit them first." >&2
  exit 1
fi
if git rev-parse -q --verify "refs/tags/v$version" >/dev/null; then
  echo "tag v$version already exists" >&2
  exit 1
fi

node -e '
  const fs = require("fs");
  const v = process.argv[1];
  for (const f of ["package.json", "src-tauri/tauri.conf.json"]) {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    j.version = v;
    fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
  }
' "$version"
npm install --package-lock-only --silent
# First `version = ` line is the [package] version.
perl -0pi -e "s/^version = \".*?\"/version = \"$version\"/m" src-tauri/Cargo.toml
cargo update --manifest-path src-tauri/Cargo.toml -p gmd --offline >/dev/null 2>&1 || true
npx prettier --write src-tauri/tauri.conf.json package.json >/dev/null

git add package.json package-lock.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "Release v$version" -m "${2:-}"
git tag -a "v$version" -m "Green Markdown v$version"
git push origin HEAD "v$version"
echo "Pushed v$version — watch the build with: gh run watch"
