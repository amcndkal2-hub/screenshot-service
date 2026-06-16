#!/bin/sh
# Auto-detect chromium path dan start server

# Cari chromium di berbagai kemungkinan path
CHROMIUM_PATH=""
for candidate in /usr/bin/chromium /usr/bin/chromium-browser /usr/bin/google-chrome /usr/bin/google-chrome-stable; do
  if [ -x "$candidate" ]; then
    CHROMIUM_PATH="$candidate"
    break
  fi
done

if [ -z "$CHROMIUM_PATH" ]; then
  echo "ERROR: Chromium tidak ditemukan di sistem!"
  echo "Mencari semua binary chromium..."
  find /usr -name "chrom*" -type f 2>/dev/null || echo "Tidak ada"
  exit 1
fi

echo "=== Chromium ditemukan: $CHROMIUM_PATH ==="
export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="$CHROMIUM_PATH"

echo "=== Starting screenshot-service on port ${PORT:-3001} ==="
exec node server.js
