#!/usr/bin/env bash
set -euo pipefail

TELEBOX_DIR="${1:-/root/telebox}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ ! -d "$TELEBOX_DIR" ]; then
  echo "TeleBox directory not found: $TELEBOX_DIR" >&2
  exit 1
fi

if [ ! -d "$TELEBOX_DIR/plugins" ]; then
  echo "TeleBox plugins directory not found: $TELEBOX_DIR/plugins" >&2
  exit 1
fi

mkdir -p "$TELEBOX_DIR/assets/sum"

cp "$REPO_DIR/plugins/sumplus.ts" "$TELEBOX_DIR/plugins/sumplus.ts"
cp "$REPO_DIR/plugins/sumplus.prepare.ts" "$TELEBOX_DIR/plugins/sumplus.prepare.ts"
cp "$REPO_DIR/plugins/sumplus.provider.ts" "$TELEBOX_DIR/plugins/sumplus.provider.ts"
cp "$REPO_DIR/plugins/sumplus.prompts.ts" "$TELEBOX_DIR/plugins/sumplus.prompts.ts"
cp "$REPO_DIR/plugins/sumplus.types.ts" "$TELEBOX_DIR/plugins/sumplus.types.ts"

if [ ! -f "$TELEBOX_DIR/assets/sum/config.json" ]; then
  cp "$REPO_DIR/assets/sum/config.example.json" "$TELEBOX_DIR/assets/sum/config.example.json"
  echo "No config.json found. Example copied to assets/sum/config.example.json"
else
  echo "Existing assets/sum/config.json kept unchanged."
fi

echo "SumPlus files installed into $TELEBOX_DIR"
echo "Restart TeleBox after reviewing config: pm2 restart telebox --update-env"

