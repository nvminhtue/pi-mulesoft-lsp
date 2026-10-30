# pi-mulesoft-lsp

A [Pi](https://github.com/earendil-works/pi) extension that gives [pi-lens](https://github.com/apmantza/pi-lens) real **MuleSoft XML diagnostics** (core + connector schemas). It runs the LemMinX server that ships in the Mule DX VS Code extension, with Anypoint Studio's bundled JDK 17, and registers it as the custom pi-lens server `mule-xml`.

**XML only.** DataWeave (`.dwl`, `ee:transform` scripts) is not covered: see [Future work](#dataweave-out-of-scope--future-work).

## Requirements

- macOS (paths and the JDK glob are macOS-specific; `/mule-lsp doctor` reports a clear failure elsewhere).
- Anypoint Studio at `/Applications/AnypointStudio.app` (JDK 17, Mule runtime jars, lsp4j/gson/guava jars, and the connector XSD cache at `~/AnypointStudio/studio-workspace/.mule/plugins-tmp/repository`).
- VS Code extension `salesforce.mule-dx-mule-dev-component` (provides `mule-dx-mule-dev-plugin-*-all.jar`).
- `unzip`, and Node 22.23.4+ / 24.22.1+ (what Pi itself needs).
- [pi-lens](https://github.com/apmantza/pi-lens) installed in Pi.

## Install

```bash
pi install npm:pi-mulesoft-lsp
# or from git
pi install git:github.com/nvminhtue/pi-mulesoft-lsp
# or a local checkout
pi install /absolute/path/to/pi-mulesoft-lsp
```

Then `/reload` (or restart Pi) and, in a Mule project, run `/mule-lsp init`.

## Commands

| Command | What it does |
| --- | --- |
| `/mule-lsp init [dir] [--global] [--yes]` | Write the launcher shim, generate the catalog if missing, check the environment, then register `lsp.servers["mule-xml"]` in the project's `.pi-lens.json` (or the global pi-lens config with `--global`) |
| `/mule-lsp catalog` | (Re)generate the schema catalog from Anypoint Studio |
| `/mule-lsp doctor` | Report 12 checks (project, Studio, JDK, jars, catalog and its freshness, pi-lens, config, trust, shim, legacy files) with the next step for each problem |
| `/mule-lsp help` | Show command help |

On `session_start`, in a Mule project (`mule-artifact.json` found above the working directory) the extension prints at most one hint per session, for example "run `/mule-lsp init`" when no config registers the server. It never migrates or edits configs on its own; the only automatic change is repairing a launcher shim whose package has disappeared.

`init` targets the nearest ancestor of the working directory that holds `mule-artifact.json` (never at or above `$HOME`), or the working directory itself. `init <dir>` targets `<dir>`. If the target has no `mule-artifact.json`, `init` asks first (UI) or only warns (no UI).

## Project mode and global mode

| | `/mule-lsp init` (project) | `/mule-lsp init --global` |
| --- | --- | --- |
| Writes | `<project>/.pi-lens.json` | The global pi-lens config |
| Applies to | That project | Every project on the machine |
| Needs `/trust` | Yes (pi-lens refuses project-supplied LSP commands in untrusted projects) | No (global config is always trusted) |
| Confirmation | Only for non-Mule directories | Always (`--yes` is required without a UI) |
| Entry | No `env` | Adds `"env": {"MULE_LSP_REQUIRE_MARKER": "1"}` |

Both modes only touch `lsp.servers["mule-xml"]`. They are idempotent, write `<config>.bak` only when the content will change and no `.bak` exists yet, and refuse (leaving the file untouched and printing the entry to merge by hand) if the config is not strict JSON (for example JSONC with comments) or if the JSON, `lsp` or `lsp.servers` is not an object.

### Where the global config lives

The extension resolves the path like pi-lens does, first match wins:

1. `PI_LENS_CONFIG_PATH` (when non-empty).
2. `~/.pi-lens/config.json`, if it exists.
3. `$PI_CODING_AGENT_DIR/extensions/pi-lens.json`, if the variable is set and the file exists.
4. `~/.pi-lens/config.json` (created when nothing exists yet).

If probing a candidate fails for a reason other than "not found", `init --global` refuses to write. pi-lens decides the location once per process, so **restart Pi** after `init --global`.

### The no-op gate (global mode)

pi-lens starts a custom server for every `.xml` file, and `rootMarkers` do not stop that: an unmatched marker falls back to the git root or session directory and the server still spawns. In global mode that would start a JVM for every `pom.xml` or Android layout.

So the global entry sets `MULE_LSP_REQUIRE_MARKER=1`. The wrapper then checks, before it looks for Java, whether a `mule-artifact.json` exists in `$PWD`, `$PWD/*/` or `$PWD/*/*/`. If not, it serves a tiny no-op LSP (`bin/mule-null-lsp.mjs`) that answers the handshake and publishes empty diagnostics, so pi-lens neither waits for a timeout nor marks the server `broken`.

Trade-off: XML files outside Mule projects show as **clean** rather than "unconfirmed". To switch the server off for a project, use `lsp.disabledServers: ["mule-xml"]` in that project's `.pi-lens.json`.

## Data directory and the launcher shim

State that must survive package updates lives in `<agentDir>/mulesoft-lsp/` (`agentDir` is `$PI_CODING_AGENT_DIR` or `~/.pi/agent`; `MULE_LSP_DATA_DIR` overrides the whole directory):

- `xsd/`: the generated schemas and `catalog.xml`.
- `bin/mule-xml-lsp`: a small **launcher shim** written by `init`. It records the absolute package path and the Node binary, and runs `bash <package>/bin/mule-xml-lsp`.

The package path differs by install source (npm, git, local path, `pi install -l`, `pi -e`), but config files need one unchanging command, so they point at the shim. If you switch install source, run `/mule-lsp init` again so the shim points at the new location. `doctor` and the session hint warn when the shim points at another install.

## Trust

pi-lens refuses project-supplied LSP commands until the project is trusted. In Pi, from the project directory, run `/trust` (stored by canonical path; on macOS `/tmp/x` becomes `/private/tmp/x`), or start Pi with `pi -a`. Then `/reload` and check `/lens-health`. Untrusted projects show "project LSP command refused for mule-xml" and get no diagnostics. Global mode does not need this.

## When to re-run `/mule-lsp catalog`

After upgrading Anypoint Studio (new runtime/JDK), or after Studio downloaded a new connector (open the project in Studio once so the connector lands in its plugin cache). `doctor` flags a catalog older than the Studio sources. Core XSDs come from the newest `org.mule.tooling.server.4.*.ee_*` (version-sorted), connector XSDs from the newest version directory per file name; connector files never override core files.

## Environment overrides

| Variable | Used by | Meaning |
| --- | --- | --- |
| `MULE_LSP_DATA_DIR` | extension, `mule-xsd-catalog` | Data directory (default `<agentDir>/mulesoft-lsp`); must be absolute with no whitespace |
| `MULE_LSP_REQUIRE_MARKER` | `mule-xml-lsp` | `1`: serve the no-op LSP unless a `mule-artifact.json` is within 2 levels of the working directory (set by `init --global`) |
| `MULE_LSP_NODE` | `mule-xml-lsp` | Node binary for the no-op LSP (the shim sets it from the Node that ran `init`) |
| `MULE_LSP_JAVA_HOME` | `mule-xml-lsp` | JDK 17 home (else the newest Studio `org.mule.tooling.jdk.v17.macosx.*`) |
| `MULE_LSP_STUDIO` | all scripts | Studio `.app` path (default `/Applications/AnypointStudio.app`) |
| `MULE_LSP_VSCODE_EXT` | `mule-xml-lsp` | VS Code extensions dir (default `~/.vscode/extensions`) |
| `MULE_LSP_RUNTIME_DIR` | `mule-xsd-catalog` | Pin one `org.mule.tooling.server.4.x.ee_*` directory |
| `MULE_LSP_CONNECTOR_XSD_ROOT` | `mule-xsd-catalog` | Connector XSD cache root |
| `PI_LENS_CONFIG_PATH` | pi-lens, `init --global` | Explicit global config file |
| `PI_LENS_LSP_INIT_TIMEOUT_MS` | pi-lens | LSP init timeout, default 15000; measured init here is about 0.8-1.6 s |

`mule-xml-lsp --check` prints `key=value` lines to stderr (`java_home`, `dev_jar`, `jar.*`, `studio`, `vscode_ext`), one `missing=<key>: <hint>` line per problem, and exits 1 if anything is missing. Stdout stays empty.

## Migrating from the standalone toolkit

Older setups kept scripts in `~/.pi/agent/mulesoft-lsp/` (`bin/`, `test/`, `README.md`, `package.json`). The first `/mule-lsp init` or `/mule-lsp catalog` moves those four items, without deleting anything, into `legacy-toolkit-YYYYMMDD/` (with a numeric suffix if that name exists) and writes the shim at the same `bin/mule-xml-lsp` path. `xsd/` stays where it is. Existing `.pi-lens.json` files keep working unchanged, and re-running `init` produces byte-identical content and no `.bak`. `session_start` never migrates.

## Design notes

- The wrapper writes nothing to stdout (stdout is the LSP channel); errors go to stderr with exit 1.
- The config entry uses `"args": []` (pi-lens would otherwise append `--stdio`) and an absolute command.
- pi-lens sends the `initializationOptions` blob at `initialize` **and** as `workspace/didChangeConfiguration.settings`. LemMinX reads `settings.xml` at init but `params.settings.xml` on change, so the blob carries both shapes (`{settings:{xml:X}, xml:X}`).
- The catalog maps `<targetNamespace>/current/<file>.xsd` (the URL Mule files use in `xsi:schemaLocation`) plus every schemaLocation URL found in the XSDs to local `file://` paths. Absolute imports inside the XSDs are rewritten to sibling file names.
- The server attaches to **every** `.xml` file in the project (`pom.xml`, `log4j2.xml`, MUnit...), since no built-in pi-lens server claims `.xml`.
- `mule-xsd-catalog` takes no arguments, writes only `$MULE_LSP_DATA_DIR/xsd`, and holds a `xsd.lock` directory while running (exit 3 if another run holds it; delete a stale lock by hand).

## Known limitations

- macOS only.
- Paths containing whitespace are unsupported (catalog `file://` URIs are not percent-encoded); `init` stops with an error if the data directory has whitespace.
- `.pi-lens.json` in JSONC form must be merged by hand.
- Connectors missing from Studio's plugin cache produce false `cvc-complex-type.2.4.a` errors. Fix: open the project in Studio once, then `/mule-lsp catalog`.
- Only the newest connector version per XSD is used.
- pi-lens has no per-code diagnostic filter, so real-but-noisy XML diagnostics on non-Mule XML in project mode cannot be suppressed.
- A project `.pi-lens.json` holds absolute paths from your machine; do not commit it for a team. Use global mode, or let each person run `init`.

## Tests

```bash
npm run check        # typecheck + unit tests (what CI runs; no Studio needed)
npm run test:local   # integration: real server probes against Studio (macOS with Studio only; not run in CI)
```

`test:local` generates the catalog into a temporary `MULE_LSP_DATA_DIR`, so your real data directory is not touched. It runs `test/lsp-probe.mjs` (which reproduces the pi-lens handshake) against `test/fixtures/mule-app`, and checks the wrapper contract, catalog generation and the global-mode gate. Probe manually: `node test/lsp-probe.mjs <project-dir> src/main/mule/x.xml [--config <file>]`.

## DataWeave: out of scope / future work

Not implemented; an earlier spike was PARTIAL. Blockers: (1) `publishDiagnostics` was empty for a `.dwl` with obvious errors, and the DW language server opened `~/.dw/tmp/Playground` instead of the real project (root/workspace folder must be passed; the bridge sent `rootUri: null`). (2) The first run downloads Maven artifacts and writes under `~/AnypointCodeBuilder/.tmp/...`, likely exceeding the 15 s init timeout. (3) A stdio-to-socket bridge must kill `MuleDXLauncher` when pi-lens closes stdin or evicts the server, or it leaves orphans.

When it works: add `bin/mule-dw-lsp` (globs and env overrides instead of hard-coded paths), register `lsp.servers.mule-dw` with `extensions: [".dwl"]`, and re-check the languageId pi-lens sends for `.dwl` (it may need `data-weave`).

## License

MIT
