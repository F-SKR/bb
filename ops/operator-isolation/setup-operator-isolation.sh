#!/bin/bash

set -eu

usage() {
  cat >&2 <<'EOF'
Usage: setup-operator-isolation.sh --bb-app-root <path> [--node-bin <path>] [--server-port <port>] [--host-daemon-port <port>]

Prepares a host so the bb control plane and bb workers run under distinct
restricted identities:

  bb-control  runs the server (control plane, web app, plugins)
  bb-worker   runs the host daemon and, inherited, every agent worker

The operator token then lives at <control data dir>/operator-token, mode
0600, owned by bb-control — unreadable to bb-worker and everything it
spawns. Nothing here starts a service or contacts the network.

Options:
  --bb-app-root <path>     installed bb-app package root (contains
                           server/dist/index.js and dist/bb-app.js); required
  --node-bin <path>        node binary for ExecStart (default: command -v node)
  --server-port <port>     control plane port (default: 38886)
  --host-daemon-port <port>  host daemon port (default: 38887)

After this script, activate with (as root):

  systemctl daemon-reload && systemctl enable --now bb-control-plane.service
  <join the worker daemon, see printed steps>
  systemctl enable --now bb-host-workers.service

Then prove the isolation: verify-operator-isolation.sh
To undo it: rollback-operator-isolation.sh
EOF
  exit 2
}

die() {
  echo "setup-operator-isolation.sh: $*" >&2
  exit 1
}

bb_app_root=
node_bin=
server_port=38886
host_daemon_port=38887

while [ $# -gt 0 ]; do
  case "$1" in
    --bb-app-root)
      [ $# -ge 2 ] || usage
      bb_app_root=$2
      shift 2
      ;;
    --node-bin)
      [ $# -ge 2 ] || usage
      node_bin=$2
      shift 2
      ;;
    --server-port)
      [ $# -ge 2 ] || usage
      server_port=$2
      shift 2
      ;;
    --host-daemon-port)
      [ $# -ge 2 ] || usage
      host_daemon_port=$2
      shift 2
      ;;
    *)
      usage
      ;;
  esac
done

[ "$(id -u)" = 0 ] || die "run as root: this creates system users and units"
[ -n "$bb_app_root" ] || usage
[ -f "$bb_app_root/server/dist/index.js" ] ||
  die "no server/dist/index.js under $bb_app_root — is --bb-app-root the installed bb-app package root?"
[ -f "$bb_app_root/dist/bb-app.js" ] ||
  die "no dist/bb-app.js under $bb_app_root — is --bb-app-root the installed bb-app package root?"
if [ -z "$node_bin" ]; then
  node_bin=$(command -v node) || die "node not found; pass --node-bin"
fi
[ -x "$node_bin" ] || die "--node-bin $node_bin is not executable"
case "$server_port" in
  ''|*[!0-9]*) die "--server-port must be a number" ;;
esac
case "$host_daemon_port" in
  ''|*[!0-9]*) die "--host-daemon-port must be a number" ;;
esac

CONTROL_USER=bb-control
WORKER_USER=bb-worker
CONTROL_DATA_DIR=/var/lib/bb-control
WORKER_DATA_DIR=/var/lib/bb-worker
UNIT_DIR=/etc/systemd/system
HERE=$(cd "$(dirname "$0")" && pwd)

create_identity() {
  user=$1
  home=$2
  if ! getent group "$user" >/dev/null; then
    groupadd --system "$user"
  fi
  if ! getent passwd "$user" >/dev/null; then
    useradd --system --gid "$user" --home-dir "$home" --create-home \
      --shell /usr/sbin/nologin "$user"
  fi
  install -d -m 0750 -o "$user" -g "$user" "$home"
}

create_identity "$CONTROL_USER" "$CONTROL_DATA_DIR"
create_identity "$WORKER_USER" "$WORKER_DATA_DIR"

token_file=$CONTROL_DATA_DIR/operator-token
if [ -e "$token_file" ]; then
  echo "operator token already present at $token_file — left untouched"
else
  (umask 077 && openssl rand -hex 32 >"$token_file") ||
    die "could not generate the operator token at $token_file"
  chown "$CONTROL_USER:$CONTROL_USER" "$token_file"
  chmod 0600 "$token_file"
  echo "generated operator token at $token_file (0600 $CONTROL_USER)"
fi
chown "$CONTROL_USER:$CONTROL_USER" "$token_file"
chmod 0600 "$token_file"

render_unit() {
  template=$1
  target=$2
  sed \
    -e "s|@NODE_BIN@|$node_bin|g" \
    -e "s|@BB_APP_ROOT@|$bb_app_root|g" \
    -e "s|@CONTROL_DATA_DIR@|$CONTROL_DATA_DIR|g" \
    -e "s|@WORKER_DATA_DIR@|$WORKER_DATA_DIR|g" \
    -e "s|@SERVER_PORT@|$server_port|g" \
    -e "s|@HOST_DAEMON_PORT@|$host_daemon_port|g" \
    "$HERE/$template" >"$target"
  chmod 0644 "$target"
}

render_unit bb-control-plane.service "$UNIT_DIR/bb-control-plane.service"
render_unit bb-host-workers.service "$UNIT_DIR/bb-host-workers.service"
systemctl daemon-reload

cat <<EOF

Prepared. Activation (as root):

  1. systemctl enable --now bb-control-plane.service
     The web app answers on http://127.0.0.1:$server_port

  2. Enroll the worker daemon once, so it authenticates as its own host:
       join_code=\$(bb connect on the operator's machine, or Settings -> Machines)
       runuser -u $WORKER_USER -- env HOME=$WORKER_DATA_DIR \\
         "$node_bin" "$bb_app_root/dist/bb-app.js" host-daemon join \\
         --server-url http://127.0.0.1:$server_port --join-code "\$join_code"

  3. systemctl enable --now bb-host-workers.service

  4. Prove it: $HERE/verify-operator-isolation.sh

The operator token is at $token_file; read it once as an operator to paste
into Settings -> Operator access (or export BB_OPERATOR_TOKEN in your own
shell). The server never mints or replaces it.
EOF
