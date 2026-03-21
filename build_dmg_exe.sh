#!/bin/zsh
set -euo pipefail

cd /Users/surajsharma/dev/tlink-studio

if command -v yarn >/dev/null 2>&1; then
  yarn install --frozen-lockfile
else
  npm install --legacy-peer-deps
fi

npm run build
node scripts/prepackage-plugins.mjs

# DMG (macOS arm64)
ARCH=arm64 TLINK_MAC_ARTIFACTS=dmg TLINK_BUNDLE_OLLAMA=0 node scripts/build-macos.mjs

# EXE (Windows x64 NSIS installer)
ARCH=x64 TLINK_WINDOWS_ARTIFACTS=nsis TLINK_BUNDLE_OLLAMA=0 node scripts/build-windows.mjs
