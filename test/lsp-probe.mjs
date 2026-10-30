// Mimics pi-lens's custom-server handshake against the server configured in <project>/.pi-lens.json.
// Usage: node lsp-probe.mjs <project-dir> <file> [--server mule-xml] [--config <file>]
// --config reads the server entry from <file> (e.g. a global config) instead of <project-dir>/.pi-lens.json.
// The server is spawned with cwd=<project-dir> and the entry's env, like pi-lens does.
// Env: WAIT_MS (default 20000) time to collect diagnostics; CFG_DELAY_MS (default 0) pause before didOpen.
// Output (stdout): "[probe] ..." info lines, "[probe] init_ms=N", then one JSON line per publishDiagnostics.
import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const serverFlag = args.indexOf("--server");
const serverId = serverFlag >= 0 ? args.splice(serverFlag, 2)[1] : "mule-xml";
const configFlag = args.indexOf("--config");
const configArg = configFlag >= 0 ? args.splice(configFlag, 2)[1] : undefined;
const [projectArg, fileArg] = args;
if (!projectArg || !fileArg) {
  console.error("usage: node lsp-probe.mjs <project-dir> <file> [--server mule-xml] [--config <file>]");
  process.exit(2);
}

const log = (...a) => console.log("[probe]", ...a);
const projectDir = realpathSync(projectArg);
const configPath = configArg ? resolve(configArg) : resolve(projectDir, ".pi-lens.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const server = config.lsp?.servers?.[serverId];
if (!server) { console.error(`no lsp.servers["${serverId}"] in ${configPath}`); process.exit(2); }

const blob = server.initializationOptions ?? {};
const rootUri = pathToFileURL(projectDir).href;
const filePath = resolve(projectDir, fileArg);
const fileUri = pathToFileURL(filePath).href;
const text = readFileSync(filePath, "utf8");
const waitMs = Number(process.env.WAIT_MS ?? 20000);

const child = spawn(server.command, server.args ?? [], {
  cwd: projectDir,
  env: { ...process.env, ...server.env },
  stdio: ["pipe", "pipe", "pipe"],
});
child.stderr.on("data", (d) => process.stderr.write("[server-stderr] " + d));
child.on("exit", (code, sig) => log(`server exited code=${code} signal=${sig}`));
child.on("error", (e) => { log("spawn error", e.message); process.exit(1); });

let buf = Buffer.alloc(0);
const pending = new Map();
const diagnostics = [];
let nextId = 1;

function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  child.stdin.write(body);
}
function request(method, params, timeoutMs) {
  const id = nextId++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((res, rej) => {
    const t = setTimeout(() => { pending.delete(id); rej(new Error(`timeout ${method} ${timeoutMs}ms`)); }, timeoutMs);
    pending.set(id, { resolve: (m) => { clearTimeout(t); res(m); } });
  });
}
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

// pi-lens answers workspace/configuration by walking the dot-path of `section` inside the blob, else {}.
function configurationFor(section) {
  if (!section) return blob;
  let cur = blob;
  for (const key of section.split(".")) {
    if (cur && typeof cur === "object" && key in cur) cur = cur[key]; else return {};
  }
  return cur;
}

function handle(msg) {
  if (msg.id !== undefined && msg.method) {
    log(`server request ${msg.method}`);
    const result = msg.method === "workspace/configuration"
      ? (msg.params?.items ?? []).map((it) => configurationFor(it.section))
      : null;
    send({ jsonrpc: "2.0", id: msg.id, result });
  } else if (msg.id !== undefined) {
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); p.resolve(msg); }
  } else if (msg.method === "textDocument/publishDiagnostics") {
    diagnostics.push(msg.params);
  } else if (msg.method === "window/logMessage" || msg.method === "window/showMessage") {
    log(`${msg.method}: ${msg.params?.message}`);
  }
}

child.stdout.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const hdrEnd = buf.indexOf("\r\n\r\n");
    if (hdrEnd < 0) return;
    const m = /Content-Length:\s*(\d+)/i.exec(buf.slice(0, hdrEnd).toString("ascii"));
    if (!m) { buf = buf.slice(hdrEnd + 4); continue; }
    const len = +m[1];
    if (buf.length < hdrEnd + 4 + len) return;
    const body = buf.slice(hdrEnd + 4, hdrEnd + 4 + len).toString("utf8");
    buf = buf.slice(hdrEnd + 4 + len);
    try { handle(JSON.parse(body)); } catch (e) { log("parse error", e.message); }
  }
}); 

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let exitCode = 0;

(async () => {
  try {
    const t0 = Date.now();
    const init = await request("initialize", {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: basename(projectDir) }],
      capabilities: { workspace: { configuration: true, didChangeConfiguration: { dynamicRegistration: false } } },
      initializationOptions: blob,
    }, Number(process.env.PI_LENS_LSP_INIT_TIMEOUT_MS ?? 30000));
    log(`init_ms=${Date.now() - t0}`);
    if (init.error) throw new Error(`initialize error ${JSON.stringify(init.error)}`);
    notify("initialized", {});
    notify("workspace/didChangeConfiguration", { settings: blob });
    await sleep(Number(process.env.CFG_DELAY_MS ?? 0));
    notify("textDocument/didOpen", { textDocument: { uri: fileUri, languageId: "xml", version: 1, text } });
    log(`didOpen ${fileUri}; collecting ${waitMs}ms`);
    await sleep(waitMs);
    log(`publishDiagnostics notifications: ${diagnostics.length}`);
    for (const d of diagnostics) console.log(JSON.stringify(d));
    await request("shutdown", null, 10000);
    log("shutdown ok");
    notify("exit", null);
  } catch (e) {
    log("ERROR:", e.message);
    exitCode = 1;
    notify("exit", null);
  }
  setTimeout(() => { child.kill("SIGKILL"); process.exit(exitCode); }, 1500);
})();
