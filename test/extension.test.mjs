import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import createDefault, { computeHint, createExtension } from "../src/index.ts";
import { catalogPath, dataDir, shimPath } from "../src/paths.ts";
import { makeDeps, makeTmp, readJson, writeFile } from "./helpers/deps.mjs";

const FULL_CHECK = "java_home=/j\ndev_jar=/d\njar.lsp4j=/a\nstudio=/s\n";

let services;
let runs;
let commands;
let events;
let notices;
let uiConfirm;
let hasUI;
let trusted;
let project;

function fakeRunner(options = {}) {
	return async (cmd, args, { env }) => {
		runs.push({ cmd, args, env });
		if (args[0].endsWith("mule-xsd-catalog")) {
			if (options.catalogFails) return { code: 1, stdout: "", stderr: "mule-xsd-catalog: ERROR: boom\n" };
			writeFile(join(env.MULE_LSP_DATA_DIR, "xsd/catalog.xml"), "<catalog/>");
			return { code: 0, stdout: "", stderr: "WARN: x\nsummary core=1 connectors=2 entries=3 out=/o\n" };
		}
		if (options.checkFails) return { code: 1, stdout: "", stderr: "missing=java_home: no usable Java 17\n" };
		return { code: 0, stdout: "", stderr: FULL_CHECK };
	};
}

function ctxFor(cwd) {
	return {
		cwd,
		hasUI,
		isProjectTrusted: () => trusted,
		ui: { notify: (message, level) => notices.push({ message, level }), confirm: async (...a) => uiConfirm(...a) },
	};
}

const pi = () => ({
	registerCommand: (name, def) => commands.set(name, def),
	on: (event, handler) => events.set(event, handler),
	getAllTools: () => [{ name: "lens_diagnostics" }],
	getSettings: () => ({ packages: ["npm:pi-lens", { source: "git:x" }] }),
});

const run = (args, cwd = project) => commands.get("mule-lsp").handler(args, ctxFor(cwd));
const lastNotice = () => notices.at(-1);

beforeEach(() => {
	const deps = makeDeps({ env: { PI_CODING_AGENT_DIR: makeTmp("agent-"), PI_LENS_CONFIG_PATH: join(makeTmp("lens-"), "global.json") } });
	services = { ...deps, runner: fakeRunner(), node: process.execPath, now: new Date("2026-05-02T00:00:00Z") };
	runs = [];
	commands = new Map();
	events = new Map();
	notices = [];
	uiConfirm = async () => true;
	hasUI = true;
	trusted = true;
	project = join(deps.home, "app");
	writeFile(join(project, "mule-artifact.json"), "{}");
	createExtension(pi(), () => services);
});

test("registers /mule-lsp and session_start; default export registers without side effects", () => {
	assert.ok(commands.has("mule-lsp"));
	assert.ok(events.has("session_start"));
	const other = { registered: [], on() {}, registerCommand(name) { this.registered.push(name); } };
	createDefault(other);
	assert.deepEqual(other.registered, ["mule-lsp"]);
	assert.deepEqual(commands.get("mule-lsp").getArgumentCompletions("in").map((c) => c.value), ["init", "init --global"]);
	assert.equal(commands.get("mule-lsp").getArgumentCompletions("zzz"), null);
});

test("help and unknown subcommands", async () => {
	await run("");
	assert.match(lastNotice().message, /\/mule-lsp init/);
	await run("bogus");
	assert.equal(lastNotice().level, "warning");
});

test("init writes the project config pointing at the stable shim and catalog", async () => {
	await run("init");
	const config = readJson(join(project, ".pi-lens.json"));
	const entry = config.lsp.servers["mule-xml"];
	assert.equal(entry.command, shimPath(services));
	assert.deepEqual(entry.initializationOptions.xml.catalogs, [catalogPath(services)]);
	assert.equal(entry.env, undefined);
	assert.ok(existsSync(shimPath(services)));
	assert.match(lastNotice().message, /\/trust/);
	assert.equal(lastNotice().level, "info");
	assert.ok(runs.some((r) => r.args[0].endsWith("mule-xsd-catalog")), "catalog generated when missing");
});

test("init is idempotent: second run reports up to date and creates no .bak", async () => {
	await run("init");
	const before = readFileSync(join(project, ".pi-lens.json"), "utf8");
	runs = [];
	await run("init");
	assert.equal(readFileSync(join(project, ".pi-lens.json"), "utf8"), before);
	assert.match(lastNotice().message, /already up to date/);
	assert.equal(existsSync(join(project, ".pi-lens.json.bak")), false);
	assert.equal(runs.some((r) => r.args[0].endsWith("mule-xsd-catalog")), false, "existing catalog is reused");
});

test("init from a subdirectory targets the Mule root; an explicit dir works from anywhere", async () => {
	writeFile(join(project, "src/main/mule/x.xml"), "<mule/>");
	await run("init", join(project, "src/main/mule"));
	assert.ok(existsSync(join(project, ".pi-lens.json")));
	const other = join(services.home, "other");
	writeFile(join(other, "mule-artifact.json"), "{}");
	await run(`init ${other}`, services.home);
	assert.ok(existsSync(join(other, ".pi-lens.json")));
});

test("init in a non-Mule dir asks first; declining writes nothing, no UI only warns", async () => {
	const plain = join(services.home, "plain");
	writeFile(join(plain, "a.txt"), "x");
	uiConfirm = async () => false;
	await run("init", plain);
	assert.equal(existsSync(join(plain, ".pi-lens.json")), false);
	hasUI = false;
	await run("init", plain);
	assert.ok(existsSync(join(plain, ".pi-lens.json")));
	assert.ok(notices.some((n) => n.level === "warning" && /mule-artifact\.json/.test(n.message)));
});

test("init migrates the legacy toolkit and keeps xsd/", async () => {
	const root = dataDir(services);
	writeFile(join(root, "bin/mule-xml-lsp"), "legacy");
	writeFile(join(root, "README.md"), "legacy");
	writeFile(join(root, "xsd/catalog.xml"), "<catalog/>");
	await run("init");
	assert.ok(existsSync(join(root, "legacy-toolkit-20260502/bin/mule-xml-lsp")));
	assert.match(readFileSync(shimPath(services), "utf8"), /generated-by: pi-mulesoft-lsp/);
	assert.equal(readFileSync(join(root, "xsd/catalog.xml"), "utf8"), "<catalog/>");
	assert.equal(runs.some((r) => r.args[0].endsWith("mule-xsd-catalog")), false);
});

test("init does not write config when the environment check or catalog generation fails", async () => {
	services.runner = fakeRunner({ checkFails: true });
	await run("init");
	assert.equal(existsSync(join(project, ".pi-lens.json")), false);
	assert.equal(lastNotice().level, "error");
	assert.match(lastNotice().message, /no usable Java 17/);
	services.fs.rmSync(catalogPath(services));
	services.runner = fakeRunner({ catalogFails: true });
	await run("init");
	assert.equal(existsSync(join(project, ".pi-lens.json")), false);
	assert.match(lastNotice().message, /boom/);
});

test("init refuses JSONC and shows the entry for manual merge", async () => {
	writeFile(join(project, ".pi-lens.json"), '{\n // c\n}\n');
	await run("init");
	assert.equal(readFileSync(join(project, ".pi-lens.json"), "utf8"), '{\n // c\n}\n');
	assert.equal(lastNotice().level, "error");
	assert.match(lastNotice().message, /"command"/);
});

test("init --global: declined confirm writes nothing", async () => {
	uiConfirm = async () => false;
	await run("init --global");
	assert.equal(existsSync(services.env.PI_LENS_CONFIG_PATH), false);
});

test("init --global without UI or --yes is refused; with --yes it writes the env-gated entry", async () => {
	hasUI = false;
	await run("init --global");
	assert.equal(existsSync(services.env.PI_LENS_CONFIG_PATH), false);
	assert.equal(lastNotice().level, "warning");
	await run("init --global --yes");
	const entry = readJson(services.env.PI_LENS_CONFIG_PATH).lsp.servers["mule-xml"];
	assert.deepEqual(entry.env, { MULE_LSP_REQUIRE_MARKER: "1" });
	assert.match(lastNotice().message, /restart pi/);
	assert.equal(existsSync(join(project, ".pi-lens.json")), false, "global init never touches the project");
});

test("init --global confirmed in the UI writes the file named by PI_LENS_CONFIG_PATH only", async () => {
	let prompt;
	uiConfirm = async (title, message) => ((prompt = message), true);
	await run("init --global");
	assert.match(prompt, new RegExp(services.env.PI_LENS_CONFIG_PATH));
	assert.ok(existsSync(services.env.PI_LENS_CONFIG_PATH));
});

test("catalog regenerates and reports the summary and warnings", async () => {
	await run("catalog");
	assert.equal(lastNotice().level, "warning");
	assert.match(lastNotice().message, /core 1, connectors 2, entries 3/);
	assert.match(lastNotice().message, /\/reload/);
	assert.ok(existsSync(catalogPath(services)));
});

test("doctor notifies a 12-item report", async () => {
	await run("init");
	await run("doctor");
	const report = lastNotice().message;
	assert.match(report, /^pi-mulesoft-lsp doctor/);
	assert.equal((report.match(/^[✓!✗] /gm) ?? []).length, 12);
});

// ---- session_start hint

const startSession = (cwd = project) => events.get("session_start")({ type: "session_start" }, ctxFor(cwd));

test("hint appears once for a Mule project without config", () => {
	startSession();
	startSession();
	assert.equal(notices.length, 1);
	assert.match(notices[0].message, /\/mule-lsp init/);
});

test("no hint outside Mule projects or when already configured and healthy", async () => {
	startSession(services.home);
	assert.equal(notices.length, 0);
	await run("init");
	notices = [];
	startSession();
	assert.equal(notices.length, 0);
});

test("hint: project-only config in an untrusted project asks for /trust", async () => {
	await run("init");
	notices = [];
	trusted = false;
	startSession();
	assert.equal(notices[0].level, "warning");
	assert.match(notices[0].message, /\/trust/);
});

test("hint repairs a dangling shim silently and warns when the shim is missing", async () => {
	await run("init");
	writeFile(shimPath(services), "# generated-by: pi-mulesoft-lsp 0\nPKG='/gone'\n");
	notices = [];
	startSession();
	assert.equal(notices.length, 0);
	assert.match(readFileSync(shimPath(services), "utf8"), /pi-mulesoft-lsp/);
	assert.doesNotMatch(readFileSync(shimPath(services), "utf8"), /\/gone/);
	services.fs.rmSync(shimPath(services));
	startSession();
	assert.match(notices[0].message, /shim is missing/);
});

test("hint is informational when the shim points at another install", async () => {
	await run("init");
	const other = makeTmp("other-");
	writeFile(join(other, "bin/mule-xml-lsp"), "x");
	writeFile(shimPath(services), `# generated-by: pi-mulesoft-lsp 0\nPKG='${other}'\n`);
	notices = [];
	startSession();
	assert.equal(notices[0].level, "info");
	assert.match(notices[0].message, /another pi-mulesoft-lsp install/);
});

test("hint never throws, even when the filesystem does", () => {
	services.fs = { ...services.fs, existsSync: () => { throw new Error("EIO"); } };
	assert.doesNotThrow(() => startSession());
	assert.equal(notices.length, 0);
	assert.throws(() => computeHint({ cwd: project, isProjectTrusted: () => true }, services), /EIO/);
});
