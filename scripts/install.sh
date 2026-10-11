#!/bin/sh
# Installs the latest `vibeshare` binary (client, provider and algorithm nodes in one file).
#   curl -fsSL https://raw.githubusercontent.com/MabzGamesStudio/VibeShare/main/scripts/install.sh | sh
# Options (environment): VIBESHARE_VERSION=v0.1.0  VIBESHARE_INSTALL_DIR=/usr/local/bin
set -eu

REPO="MabzGamesStudio/VibeShare"
DEST="${VIBESHARE_INSTALL_DIR:-$HOME/.local/bin}"

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=macos ;;
  *) echo "Unsupported system $(uname -s). On Windows use scripts/install.ps1." >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) echo "Unsupported CPU $(uname -m)." >&2; exit 1 ;;
esac

if [ -n "${VIBESHARE_VERSION:-}" ]; then
  api="https://api.github.com/repos/$REPO/releases/tags/$VIBESHARE_VERSION"
else
  api="https://api.github.com/repos/$REPO/releases/latest"
fi
url=$(curl -fsSL "$api" | grep -o "https://[^\"]*/vibeshare-[^\"/]*-$os-$arch\"" | tr -d '"' | head -n 1)
if [ -z "$url" ]; then
  echo "No vibeshare build for $os-$arch in the release." >&2
  exit 1
fi

mkdir -p "$DEST"
echo "Downloading $url"
curl -fL --progress-bar "$url" -o "$DEST/vibeshare.tmp"
chmod +x "$DEST/vibeshare.tmp"
mv "$DEST/vibeshare.tmp" "$DEST/vibeshare"
if [ "$os" = macos ]; then
  xattr -d com.apple.quarantine "$DEST/vibeshare" 2>/dev/null || true
fi

echo
echo "Installed $DEST/vibeshare"
case ":$PATH:" in
  *":$DEST:"*) ;;
  *) echo "Add it to your PATH:  export PATH=\"$DEST:\$PATH\"" ;;
esac
echo "Try it:  vibeshare demo --open"
