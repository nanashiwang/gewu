#!/usr/bin/env bash
# deploy.sh — sync this project to a remote server and (re)build its venv.
#
# First run on a fresh box:
#   ./deploy.sh
#
# Subsequent code-only changes:
#   ./deploy.sh
#
# After editing pyproject.toml dependencies:
#   ./deploy.sh --reinstall
#
# Verify with tests on remote:
#   ./deploy.sh --test
#
# Override target:
#   ./deploy.sh --host user@host --path /opt/foo
#   GEWU_HOST=user@host ./deploy.sh

set -euo pipefail

REMOTE_HOST="${GEWU_HOST:-}"
REMOTE_PATH="${GEWU_PATH:-/opt/gewu-detector}"

REINSTALL=false
RUN_TESTS=false
DRY_RUN=false
INSTALL_SYSTEMD=false
RESTART_SERVICE=false

print_usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Sync this project to a remote server, build its venv on first run,
optionally reinstall deps and run tests.

Options:
  --host HOST      ssh destination (required unless GEWU_HOST is set)
  --path PATH      remote install path (default: $REMOTE_PATH)
  --reinstall      re-run the constrained production dependency install
                   (use when pyproject.toml changed)
  --test           run pytest on remote after sync
  --dry-run        rsync -n; show what would change, copy nothing
  --install-systemd
                   install/refresh gewu.service and monitor unit templates,
                   create the service user/data directory, then enable and start
                   the web service (root deployment, default path only)
  --restart-service
                   restart an already-installed gewu.service after tests pass
  -h, --help       show this help and exit

Environment overrides: GEWU_HOST, GEWU_PATH

Prerequisite (one-time, on fresh Ubuntu 24.04):
  ssh root@server 'apt-get update && apt-get install -y python3-venv rsync curl'
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)      REMOTE_HOST="$2"; shift 2 ;;
    --path)      REMOTE_PATH="$2"; shift 2 ;;
    --reinstall) REINSTALL=true;   shift ;;
    --test)      RUN_TESTS=true;   shift ;;
    --dry-run)   DRY_RUN=true;     shift ;;
    --install-systemd) INSTALL_SYSTEMD=true; shift ;;
    --restart-service) RESTART_SERVICE=true; shift ;;
    -h|--help)   print_usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; print_usage >&2; exit 2 ;;
  esac
done

if [[ -z "$REMOTE_HOST" ]]; then
  echo "missing deployment host: pass --host or set GEWU_HOST" >&2
  exit 2
fi

if [[ ! "$REMOTE_HOST" =~ ^[A-Za-z0-9._@-]+$ ]]; then
  echo "unsafe deployment host: $REMOTE_HOST" >&2
  exit 2
fi

# REMOTE_PATH is interpolated into remote shell commands and rsync's remote
# destination. Restrict it before any network write instead of attempting to
# quote an arbitrary shell string across two parsers.
if [[ ! "$REMOTE_PATH" =~ ^/[A-Za-z0-9._/-]+$ ]] \
  || [[ "$REMOTE_PATH" == *"//"* ]] \
  || [[ "$REMOTE_PATH" == *"/../"* ]] \
  || [[ "$REMOTE_PATH" == *"/./"* ]] \
  || [[ "$REMOTE_PATH" == */.. ]] \
  || [[ "$REMOTE_PATH" == */. ]]; then
  echo "unsafe remote path: $REMOTE_PATH" >&2
  exit 2
fi

if $INSTALL_SYSTEMD && [[ "$REMOTE_PATH" != "/opt/gewu-detector" ]]; then
  echo "--install-systemd currently requires --path /opt/gewu-detector" >&2
  echo "the checked-in units intentionally use that fixed production path" >&2
  exit 2
fi

HERE="$(cd "$(dirname "$0")" && pwd)"

if $INSTALL_SYSTEMD; then
  echo "→ preflighting root access for systemd installation"
  if ! ssh "$REMOTE_HOST" 'test "$(id -u)" = 0'; then
    echo "--install-systemd requires a root SSH destination" >&2
    exit 1
  fi
fi

EXCLUDES=(
  --exclude='venv/'
  --exclude='test-venv/'
  --exclude='__pycache__/'
  --exclude='*.pyc'
  --exclude='*.pyo'
  --exclude='.git/'
  --exclude='.pytest_cache/'
  --exclude='*.egg-info/'
  --exclude='build/'
  --exclude='dist/'
  --exclude='report*.json'
  --exclude='web_data/'          # persistent web job reports on remote
  --exclude='.cache/'
  --exclude='.DS_Store'
  # .env is host-specific: local points at one relay for dev, remote points
  # at whatever you're testing right now. Never let one overwrite the other.
  --exclude='.env'
  --exclude='.env.*'            # .env.bak, .env.local, etc. — host-local
  --exclude='*.bak'             # any manual backups
  --exclude='baselines/'        # local-only output dir of bench.sh on remote
  --exclude='out/'              # ad-hoc output directory on remote
  --exclude='tmp/'              # ad-hoc tmp dir
)

RSYNC_FLAGS=(-az --delete)
$DRY_RUN && RSYNC_FLAGS+=(-n -v)

echo "→ rsync $HERE/  →  $REMOTE_HOST:$REMOTE_PATH/"
rsync "${RSYNC_FLAGS[@]}" "${EXCLUDES[@]}" "$HERE"/ "$REMOTE_HOST:$REMOTE_PATH"/

if $DRY_RUN; then
  echo "✓ dry run only, nothing changed"
  exit 0
fi

# Always lock down .env on remote — we just rsynced it.
ssh "$REMOTE_HOST" "test -f $REMOTE_PATH/.env && chmod 600 $REMOTE_PATH/.env || true"

# venv-bin/gewu existing means a working install is already there.
NEED_VENV=$(ssh "$REMOTE_HOST" \
  "test -x $REMOTE_PATH/venv/bin/gewu && echo no || echo yes")

if [[ "$NEED_VENV" == "yes" ]]; then
  echo "→ first-time venv build on remote"
  ssh "$REMOTE_HOST" "set -e; cd $REMOTE_PATH && \
    python3 -m venv venv && \
    ./venv/bin/pip install --quiet --upgrade pip && \
    ./venv/bin/pip install --quiet --constraint constraints.txt -e '.[web]'"
elif $REINSTALL; then
  echo "→ installing constrained production dependencies on remote"
  ssh "$REMOTE_HOST" "cd $REMOTE_PATH && \
    ./venv/bin/pip install --quiet --constraint constraints.txt -e '.[web]'"
fi

if $RUN_TESTS; then
  echo "→ installing isolated test dependencies and running pytest on remote"
  if ! ssh "$REMOTE_HOST" "set -e; cd $REMOTE_PATH; \
    test -x test-venv/bin/python || python3 -m venv test-venv; \
    ./test-venv/bin/pip install --quiet --upgrade pip; \
    ./test-venv/bin/pip install --quiet --constraint constraints.txt -e '.[dev,web]'; \
    ./test-venv/bin/pytest tests/"; then
    echo "✗ tests failed on remote" >&2
    exit 1
  fi
fi

if $INSTALL_SYSTEMD; then
  echo "→ installing systemd units and starting gewu.service"
  ssh "$REMOTE_HOST" "set -e; \
    test \"\$(id -u)\" = 0; \
    getent group gewu >/dev/null || groupadd --system gewu; \
    id -u gewu >/dev/null 2>&1 || useradd --system --gid gewu --home-dir $REMOTE_PATH --shell /usr/sbin/nologin gewu; \
    install -d -o gewu -g gewu -m 0750 $REMOTE_PATH/web_data $REMOTE_PATH/web_data/jobs; \
    install -d -o root -g root -m 0700 /etc/gewu-monitor; \
    install -m 0644 $REMOTE_PATH/gewu.service /etc/systemd/system/gewu.service; \
    install -m 0644 $REMOTE_PATH/gewu-monitor@.service /etc/systemd/system/gewu-monitor@.service; \
    install -m 0644 $REMOTE_PATH/gewu-monitor@.timer /etc/systemd/system/gewu-monitor@.timer; \
    systemd-analyze verify \
      /etc/systemd/system/gewu.service \
      /etc/systemd/system/gewu-monitor@.service \
      /etc/systemd/system/gewu-monitor@.timer; \
    systemctl daemon-reload; \
    systemctl enable gewu.service; \
    systemctl restart gewu.service; \
    systemctl is-active --quiet gewu.service; \
    for i in \$(seq 1 20); do \
      curl --fail --silent --show-error --max-time 2 http://127.0.0.1:8765/readyz >/dev/null && exit 0; \
      sleep 1; \
    done; \
    journalctl --unit gewu.service --lines 50 --no-pager >&2; \
    exit 1"
elif $RESTART_SERVICE; then
  echo "→ restarting gewu.service"
  ssh "$REMOTE_HOST" "set -e; \
    systemctl restart gewu.service; \
    systemctl is-active --quiet gewu.service; \
    for i in \$(seq 1 20); do \
      curl --fail --silent --show-error --max-time 2 http://127.0.0.1:8765/readyz >/dev/null && exit 0; \
      sleep 1; \
    done; \
    journalctl --unit gewu.service --lines 50 --no-pager >&2; \
    exit 1"
fi

echo "✓ deployed to $REMOTE_HOST:$REMOTE_PATH"
echo "  try:  ssh $REMOTE_HOST 'cd $REMOTE_PATH && ./venv/bin/gewu detect --mode quick'"
