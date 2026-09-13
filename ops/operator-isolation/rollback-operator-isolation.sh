#!/bin/bash

set -eu

usage() {
  cat >&2 <<'EOF'
Usage: rollback-operator-isolation.sh [--purge]

Undoes setup-operator-isolation.sh: stops and disables the two units,
removes the unit files, and reloads systemd. Identities, data directories,
and the operator token are kept by default so the deployment can be
restored by running setup again.

  --purge  additionally deletes the bb-control and bb-worker identities and
           their data directories under /var/lib. The operator token goes
           with the control data dir — rotate any credential derived from
           it (browser Settings -> Operator access, BB_OPERATOR_TOKEN in
           operator shells) after a purge.

After a rollback, any previous single-identity service (launchd plist,
systemd user unit, or bb-app launcher started as a login user) can be
started again as that user; it will reuse or create its own data dir.
EOF
  exit 2
}

die() {
  echo "rollback-operator-isolation.sh: $*" >&2
  exit 1
}

purge=no
while [ $# -gt 0 ]; do
  case "$1" in
    --purge)
      purge=yes
      shift
      ;;
    *)
      usage
      ;;
  esac
done

[ "$(id -u)" = 0 ] || die "run as root"

for unit in bb-host-workers.service bb-control-plane.service; do
  if systemctl list-unit-files "$unit" --no-legend 2>/dev/null | grep -q .; then
    systemctl disable --now "$unit" 2>/dev/null || true
  fi
  if [ -f "/etc/systemd/system/$unit" ]; then
    rm -f "/etc/systemd/system/$unit"
    echo "removed /etc/systemd/system/$unit"
  fi
done
systemctl daemon-reload

if [ "$purge" = yes ]; then
  for user in bb-worker bb-control; do
    home=$(getent passwd "$user" | cut -d: -f6 || true)
    if getent passwd "$user" >/dev/null; then
      userdel --remove "$user" 2>/dev/null ||
        die "could not remove user $user — stop its processes first"
    fi
    if [ -n "${home:-}" ] && [ -d "$home" ]; then
      rm -rf -- "$home"
      echo "removed $home"
    fi
    getent group "$user" >/dev/null && groupdel "$user" || true
  done
  echo "purged identities and data. Rotate the operator credential anywhere it was distributed."
else
  echo "kept /var/lib/bb-control, /var/lib/bb-worker, and both identities."
  echo "Re-run setup-operator-isolation.sh to restore the isolation."
fi
