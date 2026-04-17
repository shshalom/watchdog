#!/usr/bin/env bash
# Watchdog installer — downloads the right binary for your platform.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/shshalom/watchdog/main/scripts/install.sh | sh
#
set -euo pipefail

REPO="shshalom/watchdog"
BINARY="watchdog"
INSTALL_DIR="${WATCHDOG_INSTALL_DIR:-/usr/local/bin}"

say()  { printf '\033[1;36m[watchdog]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[watchdog]\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[1;31m[watchdog]\033[0m %s\n' "$*" >&2; exit 1; }

# Detect platform
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin) OS="apple-darwin" ;;
  Linux)  OS="unknown-linux-gnu" ;;
  *)      err "Unsupported OS: $OS" ;;
esac

case "$ARCH" in
  x86_64|amd64)  ARCH="x86_64" ;;
  arm64|aarch64) ARCH="aarch64" ;;
  *)             err "Unsupported architecture: $ARCH" ;;
esac

TARGET="${ARCH}-${OS}"
say "Detected platform: $TARGET"

# Fetch latest release tag
say "Fetching latest release from github.com/${REPO}..."
TAG=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
  | grep -o '"tag_name": *"[^"]*"' \
  | head -n 1 \
  | sed 's/.*"\(v[^"]*\)"/\1/')

if [ -z "$TAG" ]; then
  err "Could not determine latest release tag"
fi
say "Latest release: $TAG"

# Download
URL="https://github.com/${REPO}/releases/download/${TAG}/${BINARY}-${TARGET}.tar.gz"
TMPDIR=$(mktemp -d)
trap "rm -rf '$TMPDIR'" EXIT

say "Downloading $URL..."
curl -fsSL "$URL" -o "$TMPDIR/watchdog.tar.gz"
tar -xzf "$TMPDIR/watchdog.tar.gz" -C "$TMPDIR"

# Install
if [ ! -w "$INSTALL_DIR" ]; then
  warn "$INSTALL_DIR is not writable — using sudo"
  sudo install -m 755 "$TMPDIR/$BINARY" "$INSTALL_DIR/$BINARY"
else
  install -m 755 "$TMPDIR/$BINARY" "$INSTALL_DIR/$BINARY"
fi

say "Installed to $INSTALL_DIR/$BINARY"
say "Version: $("$INSTALL_DIR/$BINARY" --version 2>/dev/null || echo "$TAG")"
say ""
say "Next steps:"
say "  cd /path/to/your/project"
say "  watchdog init"
say "  watchdog start"
