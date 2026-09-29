#!/usr/bin/env bash
#
# 03-app-install.sh — the bot's code and dependencies. Run as root on the new
# host: `bash 03-app-install.sh [git-ref]` (default: refactor). It does the
# work as the `biblicana` user.
#
# Installs with pnpm from the TRACKED pnpm-lock.yaml. The old host used npm
# with an untracked package-lock.json that was stale (v1.4.0), so what ran in
# prod was never exactly what was tested. This closes that.
#
# Data files and .env are NOT handled here (runbook steps 4 and 5).
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
REF=${1:-refactor}
APP=/srv/biblicana
REPO=https://github.com/Lionmark-LLC/Biblicana.git

install -d -m 750 -o biblicana -g biblicana "$APP"

sudo -iu biblicana bash -euo pipefail <<EOF
cd "$APP"
if [ ! -d .git ]; then
    git clone "$REPO" .
fi
git fetch origin
git checkout "$REF"
git pull --ff-only origin "$REF"
git log -1 --format='HEAD %h %ad %s' --date=short

# pnpm 10, as local dev uses. onlyBuiltDependencies in package.json lets the
# sqlite3 native build run. pnpm will warn that @sentry/node-cpu-profiler's
# build script was ignored: expected, it ships prebuilt linux-x64 binaries.
corepack prepare pnpm@10 --activate
pnpm install --frozen-lockfile

echo "-- native modules load on this Node:"
node -v
node -e "import('sqlite3').then(m => console.log('sqlite3 ok', typeof m.default.Database))"
node -e "import('@sentry/profiling-node').then(() => console.log('profiler ok'))"
mkdir -p data
EOF

echo
echo "NEXT: runbook step 4 (copy data/ from the old host, verify md5), step 5 (.env)."
