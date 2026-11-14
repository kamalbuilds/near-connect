#!/usr/bin/env bash
# Bundle the hosted demo (web/) from demo/ and the real connector source in src/.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p web
cp demo/index.html demo/style.css demo/favicon.ico demo/favicon.svg demo/og.png web/
node_modules/.bin/esbuild demo/src/main.ts --bundle --minify --format=iife --target=es2022 --outfile=web/app.js --log-level=warning
ls -la web
