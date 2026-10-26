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
  x86_64 | amd64) arch=x64; package=executable ;;
  arm64 | aarch64) arch=arm64; package=executable ;;
  i386 | i486 | i586 | i686 | x86) arch=ia32; package=archive ;;
  armv7l | armv7) arch=armv7l; package=archive ;;
  *) echo "Unsupported CPU $(uname -m)." >&2; exit 1 ;;
esac

if [ -n "${VIBESHARE_VERSION:-}" ]; then
  api="https://api.github.com/repos/$REPO/releases/tags/$VIBESHARE_VERSION"
else
  api="https://api.github.com/repos/$REPO/releases/latest"
fi
url=$(curl -fsSL "$api" | grep -o "https://[^\"]*/vibeshare-[^\"/]*-$os-$arch[^\\\"]*\"" | tr -d '"' | head -n 1)
if [ -z "$url" ]; then
  echo "No vibeshare build for $os-$arch in the release." >&2
  exit 1
fi

mkdir -p "$DEST"
echo "Downloading $url"
if [ "$package" = archive ]; then
  # 32-bit server distributions are archives: app, Node runtime and launchers.
  archive="$DEST/vibeshare-$arch.tar.gz"
  install_dir="$DEST/vibeshare-$arch"
  curl -fL --progress-bar "$url" -o "$archive.tmp"
  mv "$archive.tmp" "$archive"
  rm -rf "$install_dir"
  mkdir -p "$install_dir"
  tar -xzf "$archive" -C "$install_dir"
  chmod +x "$install_dir/vibeshare" "$install_dir/vibeshare-provider" "$install_dir/vibeshare-algorithm"
  ln -sf "$install_dir/vibeshare" "$DEST/vibeshare"
else
  curl -fL --progress-bar "$url" -o "$DEST/vibeshare.tmp"
  chmod +x "$DEST/vibeshare.tmp"
  mv "$DEST/vibeshare.tmp" "$DEST/vibeshare"
fi
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
