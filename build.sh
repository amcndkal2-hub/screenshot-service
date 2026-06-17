#!/bin/bash
set -e

echo "==> [build] npm install..."
npm install

BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/render/project/src/.playwright}"
SHELL_DIR="$BROWSERS_PATH/chromium_headless_shell-1217"
SHELL_BIN="$SHELL_DIR/chrome-headless-shell-linux64/chrome-headless-shell"

echo "==> [build] Checking chromium at: $SHELL_BIN"

if [ -f "$SHELL_BIN" ]; then
  echo "==> [build] Chrome headless shell already exists, skipping download."
else
  echo "==> [build] Downloading Chrome Headless Shell (~112MB)..."
  mkdir -p "$SHELL_DIR"
  
  ZIP="/tmp/chrome-headless-shell.zip"
  wget -q --show-progress \
    https://cdn.playwright.dev/builds/cft/147.0.7727.15/linux64/chrome-headless-shell-linux64.zip \
    -O "$ZIP"
  
  echo "==> [build] Extracting..."
  unzip -q "$ZIP" -d "$SHELL_DIR"
  rm -f "$ZIP"
  
  chmod +x "$SHELL_BIN"
  
  # Buat INSTALLATION_COMPLETE marker (seperti yang playwright buat)
  touch "$SHELL_DIR/INSTALLATION_COMPLETE"
  
  echo "==> [build] Chrome Headless Shell installed at: $SHELL_BIN"
fi

echo "==> [build] Done!"
ls -la "$SHELL_DIR/"
