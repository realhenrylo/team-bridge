#!/usr/bin/env bash
# usage: ./scripts-release.sh 0.3.0
# Builds the plugin bundle and bumps plugin.json's version. Users on this
# marketplace receive the update only when this version string changes.
set -euo pipefail
v="${1:?version required, e.g. 0.3.0}"
pnpm build
node -e "
const fs=require('fs');const p='plugin/.claude-plugin/plugin.json';
const j=JSON.parse(fs.readFileSync(p,'utf8'));j.version='$v';
fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n');"
echo "plugin/.claude-plugin/plugin.json -> $v; plugin/dist/team-bridge.cjs rebuilt."
echo "next: git add -A && git commit -m 'release plugin $v' && git push"
echo "colleagues: /plugin update team-bridge@team-bridge-marketplace (or auto-update)"
