#!/usr/bin/env bash
# LOCAL-ONLY integration tests for the mule-xml LSP setup (needs Anypoint Studio + the Mule DX VS Code extension).
# NOT run in CI: `npm run check` covers the unit tests. Usage: npm run test:local  (or bash test/run-tests.sh)
# Everything runs against a temp data dir (MULE_LSP_DATA_DIR) so your real ~/.pi/agent/mulesoft-lsp is never touched.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
BIN="$ROOT/bin"
WAIT_MS="${WAIT_MS:-8000}"
export WAIT_MS
PASS=0; FAIL=0
ok()   { echo "PASS: $1"; PASS=$((PASS+1)); }
bad()  { echo "FAIL: $1"; FAIL=$((FAIL+1)); }
check() { local name="$1"; shift; if "$@"; then ok "$name"; else bad "$name"; fi; }

T=$(mktemp -d /tmp/mule-lsp-test.XXXXXX)
trap 'rm -rf "$T"' EXIT
export MULE_LSP_DATA_DIR="${MULE_LSP_DATA_DIR:-$T/data}"
INIT=(node --experimental-strip-types --no-warnings "$HERE/helpers/init-cli.mjs")

# --- server wrapper contract ---
bash "$BIN/mule-xml-lsp" --check >/dev/null 2>&1; check "mule-xml-lsp --check exits 0" test $? -eq 0
OUT=$(MULE_LSP_JAVA_HOME=/nonexistent bash "$BIN/mule-xml-lsp" --check 2>"$T/check.err"); RC=$?
check "failure path: exit 1 and empty stdout" test "$RC" -eq 1 -a -z "$OUT"
check "failure path: reports missing=java_home" grep -q '^missing=java_home' "$T/check.err"

# --- catalog generation (into the temp data dir) ---
bash "$BIN/mule-xsd-catalog" >"$T/cat.out" 2>"$T/cat.err"; check "mule-xsd-catalog exits 0" test $? -eq 0
check "mule-xsd-catalog prints a summary line" grep -q '^summary core=' "$T/cat.err"
bash "$BIN/mule-xsd-catalog" "$T/should-not-exist" >/dev/null 2>&1; RC=$?
check "mule-xsd-catalog rejects an OUT argument" test "$RC" -ne 0 -a ! -e "$T/should-not-exist"
mkdir "$MULE_LSP_DATA_DIR/xsd.lock"
bash "$BIN/mule-xsd-catalog" >/dev/null 2>&1; RC=$?
check "mule-xsd-catalog refuses to run while locked (exit 3)" test "$RC" -eq 3
rmdir "$MULE_LSP_DATA_DIR/xsd.lock"
MULE_LSP_DATA_DIR=relative/path bash "$BIN/mule-xsd-catalog" >/dev/null 2>&1; RC=$?
check "mule-xsd-catalog rejects a relative data dir" test "$RC" -eq 2
MULE_LSP_DATA_DIR=/ bash "$BIN/mule-xsd-catalog" >/dev/null 2>&1; RC=$?
check "mule-xsd-catalog rejects '/' as data dir" test "$RC" -eq 2

CAT="$MULE_LSP_DATA_DIR/xsd/catalog.xml"
check "catalog has core mule.xsd entry" grep -q 'core/current/mule.xsd' "$CAT"
check "catalog has http/current/mule-http.xsd entry" grep -q 'http/current/mule-http.xsd' "$CAT"

# --- project registration + probes ---
cp -R "$HERE/fixtures/mule-app" "$T/app"
"${INIT[@]}" "$T/app" >/dev/null 2>&1; check "init helper exits 0" test $? -eq 0
PROBES="bad-core good-http bad-http"
for f in $PROBES; do
  ( node "$HERE/lsp-probe.mjs" "$T/app" "src/main/mule/$f.xml" >"$T/$f.out" 2>"$T/$f.err"; echo $? >"$T/$f.rc" ) &
done
wait

# diag_summary <out-file> <file-name>: prints "<severity1 count> <count mentioning badElement>" using only the
# LAST publishDiagnostics for the URI ending in <file-name>; prints "-1 -1" if none was published.
diag_summary() {
  node -e '
    const lines = require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter((l) => l.startsWith("{"));
    const last = lines.map((l) => JSON.parse(l)).filter((p) => p.uri.endsWith("/" + process.argv[2])).pop();
    if (!last) { console.log("-1 -1"); process.exit(0); }
    const errs = last.diagnostics.filter((d) => d.severity === 1);
    console.log(errs.length, errs.filter((d) => d.message.includes("badElement")).length);
  ' "$1" "$2"
}
# probe_ok <name>: probe exited 0, published >=1 diagnostics notification for its file, and shut down cleanly
probe_ok() {
  [ "$(cat "$T/$1.rc")" = "0" ] && grep -q '^\[probe\] shutdown ok' "$T/$1.out" \
    && [ "$(diag_summary "$T/$1.out" "$1.xml" | cut -d' ' -f1)" -ge 0 ]
}
for f in $PROBES; do check "probe $f: >=1 publishDiagnostics and clean shutdown" probe_ok "$f"; done

read -r CORE_N CORE_BAD < <(diag_summary "$T/bad-core.out" bad-core.xml)
check "bad-core.xml reports badElement" test "$CORE_BAD" -ge 1
read -r GOOD_N _ < <(diag_summary "$T/good-http.out" good-http.xml)
check "good-http.xml has 0 error diagnostics" test "$GOOD_N" -eq 0
read -r BADH_N BADH_BAD < <(diag_summary "$T/bad-http.out" bad-http.xml)
check "bad-http.xml has exactly 1 error (badElement)" test "$BADH_N" -eq 1 -a "$BADH_BAD" -eq 1

# --- global-mode gate: non-Mule dir gets the no-op server, Mule project still gets real diagnostics ---
GCFG="$T/global.json"
"${INIT[@]}" --global "$GCFG" >/dev/null 2>&1; check "global init helper exits 0" test $? -eq 0
check "global entry carries MULE_LSP_REQUIRE_MARKER" grep -q '"MULE_LSP_REQUIRE_MARKER": "1"' "$GCFG"
mkdir "$T/plain" && printf '<project><notMule/></project>\n' > "$T/plain/pom.xml"
( cd "$T" && WAIT_MS=1500 node "$HERE/lsp-probe.mjs" "$T/plain" pom.xml --config "$GCFG" >"$T/plain.out" 2>"$T/plain.err"; echo $? >"$T/plain.rc" ) &
( WAIT_MS="$WAIT_MS" node "$HERE/lsp-probe.mjs" "$T/app" src/main/mule/bad-core.xml --config "$GCFG" >"$T/gbad.out" 2>"$T/gbad.err"; echo $? >"$T/gbad.rc" ) &
wait
check "global mode, non-Mule dir: clean shutdown" bash -c '[ "$(cat "$1")" = 0 ] && grep -q "^\[probe\] shutdown ok" "$2"' _ "$T/plain.rc" "$T/plain.out"
read -r PLAIN_N _ < <(diag_summary "$T/plain.out" pom.xml)
check "global mode, non-Mule dir: 0 diagnostics published" test "$PLAIN_N" -eq 0
check "global mode, non-Mule dir: no JVM server started (no server-stderr)" bash -c '! grep -q "server-stderr" "$1"' _ "$T/plain.err"
read -r _ GBAD < <(diag_summary "$T/gbad.out" bad-core.xml)
check "global mode, Mule project: still reports badElement" test "$GBAD" -ge 1

echo "---- passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ]
