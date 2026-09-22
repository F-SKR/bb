#!/bin/bash

set -u

usage() {
  cat >&2 <<'EOF'
Usage: verify-operator-isolation.sh [--server-url <url>] [--token-file <path>]

Proves, on the deployed host and as root, that the operator-only boundary
holds under the distinct-identity deployment from setup-operator-isolation.sh:

  identity   the control plane runs as bb-control, the worker daemon (and
             with it every agent worker) as bb-worker
  denial     bb-worker cannot read the operator token, cannot read the
             server's process memory or environment, and cannot write the
             control-plane data dir
  gate       the live server refuses an operator-only mutation with no
             credential (403) and with a spoofed credential (403), allows
             it with the real one (200), and audits all three

Every check prints PASS or FAIL with evidence; any FAIL exits nonzero.
This is the actual worker-denial proof: run it against the deployment, as
root, after activation. It creates one preset (operator-isolation-verify)
and deletes it again.
EOF
  exit 2
}

die() {
  echo "verify-operator-isolation.sh: $*" >&2
  exit 1
}

server_url=http://127.0.0.1:38886
token_file=/var/lib/bb-control/operator-token
control_data_dir=/var/lib/bb-control

while [ $# -gt 0 ]; do
  case "$1" in
    --server-url)
      [ $# -ge 2 ] || usage
      server_url=$2
      shift 2
      ;;
    --token-file)
      [ $# -ge 2 ] || usage
      token_file=$2
      control_data_dir=$(dirname "$2")
      shift 2
      ;;
    *)
      usage
      ;;
  esac
done

[ "$(id -u)" = 0 ] || die "run as root: the denial probes impersonate bb-worker"

command -v runuser >/dev/null || die "runuser not found"
command -v curl >/dev/null || die "curl not found"

failures=0
pass() {
  echo "PASS  $*"
}
fail() {
  echo "FAIL  $*"
  failures=$((failures + 1))
}

worker_run() {
  runuser -u bb-worker -- env HOME=/var/lib/bb-worker /bin/sh -c "$1"
}

rpc_status=
rpc_body=
rpc() {
  method=$1
  shift
  token_header=$1
  shift
  body=$1
  shift
  out=$(curl -sS -w '\n%{http_code}' -X POST \
    "$server_url/api/v1/plugins/tasks/rpc/$method" \
    -H 'content-type: application/json' \
    ${token_header:+-H "x-bb-operator-token: $token_header"} \
    -d "$body") || out=$'\n000'
  rpc_status=$(printf '%s' "$out" | tail -1)
  rpc_body=$(printf '%s' "$out" | sed '$d')
}

json_field_ok() {
  expr=$1
  printf '%s' "$rpc_body" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const j = JSON.parse(s);
        process.exit(eval(process.argv[1]) ? 0 : 1);
      } catch {
        process.exit(1);
      }
    });
  ' "$expr" 2>/dev/null
}

expect_refusal() {
  if [ "$rpc_status" = 403 ] && json_field_ok "j.ok === false && (j.error || {}).code === 'operator_auth_required'"; then
    pass "$1"
  else
    fail "$1 — got status '$rpc_status', body: ${rpc_body:-<empty>}; expected 403 with {ok:false,error:{code:\"operator_auth_required\"}}"
  fi
}

expect_allowed() {
  if [ "$rpc_status" = 200 ] && json_field_ok "j.ok === true"; then
    pass "$1"
  else
    fail "$1 — got status '$rpc_status', body: ${rpc_body:-<empty>}; expected 200 with {ok:true,...}"
  fi
}

echo "== identity separation =="

control_uid=$(systemctl show -p MainUID --value bb-control-plane.service 2>/dev/null || echo "")
expected_control_uid=$(id -u bb-control 2>/dev/null || echo "")
if [ -n "$control_uid" ] && [ -n "$expected_control_uid" ] &&
  [ "$control_uid" = "$expected_control_uid" ]; then
  pass "control plane runs as bb-control (uid $control_uid)"
else
  fail "control plane MainUID is '${control_uid:-unset}', expected bb-control (uid ${expected_control_uid:-unset})"
fi

worker_uid=$(systemctl show -p MainUID --value bb-host-workers.service 2>/dev/null || echo "")
expected_worker_uid=$(id -u bb-worker 2>/dev/null || echo "")
if [ -n "$worker_uid" ] && [ -n "$expected_worker_uid" ] &&
  [ "$worker_uid" = "$expected_worker_uid" ]; then
  pass "host workers run as bb-worker (uid $worker_uid)"
else
  fail "host workers MainUID is '${worker_uid:-unset}', expected bb-worker (uid ${expected_worker_uid:-unset})"
fi

server_pid=$(systemctl show -p MainPID --value bb-control-plane.service 2>/dev/null || echo "")
if [ -n "$server_pid" ] && [ "$server_pid" != 0 ]; then
  pass "control plane main pid $server_pid"
else
  fail "control plane is not running; start bb-control-plane.service first"
fi

echo "== worker denial =="

if worker_run "cat '$token_file'" >/dev/null 2>&1; then
  fail "bb-worker read the operator token at $token_file"
else
  pass "bb-worker cannot read the operator token ($token_file)"
fi

if worker_run "echo x > '$control_data_dir/.probe'" >/dev/null 2>&1; then
  fail "bb-worker wrote into $control_data_dir"
  rm -f "$control_data_dir/.probe"
else
  pass "bb-worker cannot write the control-plane data dir ($control_data_dir)"
fi

if [ -n "${server_pid:-}" ] && [ "$server_pid" != 0 ]; then
  if worker_run "cat /proc/$server_pid/environ" >/dev/null 2>&1; then
    fail "bb-worker read the server's environment (/proc/$server_pid/environ)"
  else
    pass "bb-worker cannot read the server's environment (/proc/$server_pid/environ)"
  fi
  if worker_run "head -c 1 /proc/$server_pid/mem" >/dev/null 2>&1; then
    fail "bb-worker read the server's memory (/proc/$server_pid/mem)"
  else
    pass "bb-worker cannot read the server's memory (/proc/$server_pid/mem)"
  fi
fi

echo "== operator gate on the live server =="

health=$(curl -sS -o /dev/null -w '%{http_code}' "$server_url/health" 2>/dev/null || echo 000)
if [ "$health" = 200 ]; then
  pass "server answers /health with 200"
else
  fail "server /health returned '$health'; is the control plane up at $server_url?"
fi

create_body='{"name":"operator-isolation-verify","providerId":"claude-code","modelId":"claude-haiku-4-5-20251001","reasoningLevel":"medium","permissionMode":"accept-edits"}'

rpc createPreset "" "$create_body"
expect_refusal "operator-only mutation without a credential refused (403, operator_auth_required)"

rpc createPreset "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" "$create_body"
expect_refusal "operator-only mutation with a spoofed credential refused (403, operator_auth_required)"

if [ -r "$token_file" ]; then
  real_token=$(tr -d ' \n' <"$token_file")
  rpc createPreset "$real_token" "$create_body"
  expect_allowed "operator-only mutation with the real credential allowed (200)"
  preset_id=$(json_field_ok "(j.result || {}).preset && j.result.preset.id" && \
    printf '%s' "$rpc_body" | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{const j=JSON.parse(s);process.stdout.write(j.result.preset.id)})') || true

  if [ -n "$preset_id" ]; then
    rpc deletePreset "$real_token" "{\"presetId\":\"$preset_id\"}"
    if [ "$rpc_status" = 200 ] && json_field_ok "j.ok === true && j.result.deleted === true"; then
      pass "verification preset cleaned up ($preset_id)"
    else
      fail "cleanup deletePreset returned status '$rpc_status' body '${rpc_body:-<empty>}'; remove preset $preset_id manually"
    fi
  else
    fail "could not read the created preset's id from the createPreset response (body: ${rpc_body:-<empty>}); remove operator-isolation-verify manually"
  fi
else
  fail "operator token at $token_file is not readable by root; cannot prove the allowed path"
fi

echo "== audit =="

audit_file=$control_data_dir/operator-audit.jsonl
if [ -f "$audit_file" ]; then
  if tail -20 "$audit_file" | grep -q '"outcome":"refused"' &&
    tail -20 "$audit_file" | grep -q '"outcome":"allowed"'; then
    pass "audit records both the refusals and the allowed mutation"
  else
    fail "audit at $audit_file is missing refused/allowed rows for the probes above"
  fi
else
  fail "no audit file at $audit_file"
fi

echo
if [ "$failures" -eq 0 ]; then
  echo "operator isolation verified: workers are denied, the operator gate holds"
  exit 0
fi
echo "$failures check(s) FAILED — the deployment does not enforce the operator boundary"
exit 1
