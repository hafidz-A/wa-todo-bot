#!/usr/bin/env bash
# Bungkus kode bot ke dalam satu file dist/install.sh yang bisa dijalankan di VPS.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist
payload="$(tar --exclude=node_modules --exclude=data --exclude=dist --exclude=.env --exclude='*.zip' \
  -czf - package.json package-lock.json README.md .env.example .gitignore src test scripts | base64 -w0 | fold -w 76)"
awk -v payload="$payload" '{ if ($0 == "__PAYLOAD__") print payload; else print }' scripts/install.template.sh > dist/install.sh
chmod +x dist/install.sh
echo "dist/install.sh ($(wc -c < dist/install.sh) byte)"
