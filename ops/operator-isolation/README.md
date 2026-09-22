# Operator isolation: distinct identities for control plane and workers

The operator-only boundary (docs/configuration.md "Operator access") is
enforced by a bearer credential. A credential cannot protect against a
process that can read it, so on a host where the bb server and agent
workers run as the same OS user, the boundary does not hold against those
workers: the default `bb-app` launcher starts the server, the host daemon,
and every worker child in ONE process tree under ONE uid, and that uid can
read the data-dir token. This directory is the installable fix: two
systemd system units that split that tree across two restricted identities.

| Identity    | Runs | Data dir |
|-------------|------|----------|
| `bb-control` | server + web app + plugins (no worker daemon child) | `/var/lib/bb-control` (0750) |
| `bb-worker`  | host daemon, and — inherited — every agent worker it spawns | `/var/lib/bb-worker` (0750) |

The operator token lives at `/var/lib/bb-control/operator-token`, mode
0600, owned by `bb-control`. After the split, `bb-worker` cannot read the
credential, cannot read the server's process memory or environment
(cross-uid `/proc` access requires the target to be dumpable AND uid-equal;
a different uid is denied outright), and cannot write the control-plane
data dir. `BB_OPERATOR_TOKEN_FILE` points at the token explicitly so the
server never falls back to a data-dir default.

## What is closed, and what is not

Closed by this deployment (and proven by `verify-operator-isolation.sh`):

- Workers cannot read the credential at rest, so they cannot mint
  operator-authorized mutations while unattended.
- Workers cannot lift the credential from the server's memory or
  environment, which no file permission scheme achieves for same-uid
  processes.
- Workers cannot tamper with control-plane data (db, audit log, presets).

Not closed by any configuration in this directory — say so in any report:

- A worker that compromises the KERNEL or root still sees everything.
- The operator presenting the real token through a compromised sanctioned
  path (browser, CLI) is out of scope; the credential is doing its job.
- Anything the server itself runs as `bb-control` — plugins are full-trust
  control-plane code. This boundary is between the control plane and
  WORKERS, not between bb and its plugins.

## Reproducible activation

One time, as root, with an installed bb-app package root (the directory
containing `server/dist/index.js` and `dist/bb-app.js`):

    sudo ./setup-operator-isolation.sh --bb-app-root /path/to/bb-app

The script is idempotent: it creates both system users (`/var/lib/...`
homes, `nologin` shells), installs the unit files into
`/etc/systemd/system`, generates the operator token if none exists, and
never overwrites an existing token. It starts nothing. Activation:

    systemctl enable --now bb-control-plane.service
    # enroll the worker daemon once (join code from Settings -> Machines):
    runuser -u bb-worker -- env HOME=/var/lib/bb-worker \
      <node> <bb-app-root>/dist/bb-app.js host-daemon join \
      --server-url http://127.0.0.1:38886 --join-code <code>
    systemctl enable --now bb-host-workers.service
    sudo ./verify-operator-isolation.sh

Ports default to the production ports (server 38886, host daemon 38887);
pass `--server-port` / `--host-daemon-port` to move them. The unit files
carry systemd hardening (no new privileges, private tmp, read-only system
tree with only the service's own data dir writable, no capabilities); they
intentionally do NOT set `MemoryDenyWriteExecute`, which breaks V8's JIT.

## Actual worker-denial verification plan

`verify-operator-isolation.sh` is the proof, run as root on the deployed
host after activation. It asserts, with printed evidence and a nonzero
exit on any failure:

1. Identity: `systemctl show -p MainUID` matches `bb-control` for the
   control plane and `bb-worker` for the worker daemon.
2. Denial, exercised AS `bb-worker` (`runuser`): reading the token file
   fails; writing the control data dir fails; reading
   `/proc/<server>/environ` fails; opening `/proc/<server>/mem` fails.
3. Gate on the live server: the operator-only `tasks.createPreset` RPC
   returns 403 with no credential, 403 with a spoofed credential, 200 with
   the real one (and the probe preset is deleted again); the audit file
   records both the refusals and the allowed mutation.

Run it after activation AND after any change to the deployment (node
upgrade, unit edit, OS update) — it is the evidence the boundary still
holds. Without a deployment of this kind, do not claim the shared-uid
bypass is closed: a same-uid worker can read any credential the server can.

## Reproducible rollback

    sudo ./rollback-operator-isolation.sh          # stop + remove the units
    sudo ./rollback-operator-isolation.sh --purge  # also delete identities and data

By default the rollback keeps both identities, their data directories, and
the token, so `setup-operator-isolation.sh` restores the split unchanged.
`--purge` removes the identities and data entirely; the operator token is
destroyed with the control data dir, so rotate any distributed copy of it
(browser Settings → Operator access, `BB_OPERATOR_TOKEN` in operator
shells) after a purge. The previous single-identity service can be started
again independently; this directory never touches it.
