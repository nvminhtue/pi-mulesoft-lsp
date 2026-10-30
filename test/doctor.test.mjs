import assert from "node:assert/strict";
import { symlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { collectChecks, formatReport, worstStatus } from "../src/doctor.ts";
import { ensureShim } from "../src/install.ts";
import { applyServerEntry, buildEntry } from "../src/lens-config.ts";
import { catalogPath, shimPath } from "../src/paths.ts";
import { makeDeps, makeTmp, writeFile } from "./helpers/deps.mjs";

const FULL_CHECK = [
	"java_home=/j", "dev_jar=/d.jar", "jar.lsp4j=/a", "jar.lsp4j.jsonrpc=/b", "jar.gson=/c", "jar.guava=/e",
	"jar.failureaccess=/f", "studio=/Applications/AnypointStudio.app", "vscode_ext=/v", "",
].join("\n");

function setup({ checkStderr = FULL_CHECK, checkCode = 0 } = {}) {
	const studio = makeTmp("studio-");
	const connectors = makeTmp("conn-");
	const deps = makeDeps({ env: { PI_CODING_AGENT_DIR: makeTmp("agent-"), MULE_LSP_STUDIO: studio, MULE_LSP_CONNECTOR_XSD_ROOT: connectors } });
	deps.runner = async () => ({ code: checkCode, stdout: "", stderr: checkStderr });
	const project = join(deps.home, "app");
	writeFile(join(project, "mule-artifact.json"), "{}");
	writeFile(join(connectors, "http/1.0/mule-http.xsd"), "<xsd/>");
	const old = new Date(Date.now() - 3_600_000);
	utimesSync(join(connectors, "http/1.0/mule-http.xsd"), old, old);
	writeFile(catalogPath(deps), '<catalog><system systemId="http://www.mulesoft.org/schema/mule/http/current/mule-http.xsd" uri="file:///x"/></catalog>');
	ensureShim(deps, { node: process.execPath, version: "1" });
	applyServerEntry(join(project, ".pi-lens.json"), buildEntry({ mode: "project", command: shimPath(deps), catalog: catalogPath(deps) }), deps);
	const context = { cwd: project, isProjectTrusted: true, toolNames: ["lens_diagnostics"], settingsPackages: [] };
	return { deps, context, connectors };
}

const byId = (items) => Object.fromEntries(items.map((entry) => [entry.id, entry]));

test("a complete setup reports 12 items, all ok", async () => {
	const { deps, context } = setup();
	const items = await collectChecks(context, deps);
	assert.equal(items.length, 12);
	assert.deepEqual(items.filter((entry) => entry.status !== "ok"), []);
	assert.equal(worstStatus(items), "ok");
	assert.doesNotMatch(formatReport(items), /Next:/);
});

test("missing JDK and jar are failures with hints", async () => {
	const stderr = "studio=/s\ndev_jar=/d\nmissing=java_home: no usable Java 17\nmissing=jar.gson: gson not found\n";
	const { deps, context } = setup({ checkStderr: stderr, checkCode: 1 });
	const items = byId(await collectChecks(context, deps));
	assert.equal(items.jdk.status, "fail");
	assert.match(items.jdk.detail, /no usable Java 17/);
	assert.equal(items.jars.status, "fail");
	assert.equal(items.studio.status, "ok");
	assert.ok(items.jdk.hint);
});

test("a catalog older than Studio's XSDs is flagged stale", async () => {
	const { deps, context, connectors } = setup();
	const old = new Date(Date.now() - 7_200_000);
	utimesSync(catalogPath(deps), old, old);
	writeFile(join(connectors, "db/2.0/mule-db.xsd"), "<xsd/>");
	const items = byId(await collectChecks(context, deps));
	assert.equal(items.freshness.status, "warn");
	assert.match(items.freshness.hint, /mule-lsp catalog/);
});

test("a missing or http-less catalog is reported", async () => {
	const { deps, context } = setup();
	writeFile(catalogPath(deps), '<catalog><system systemId="a" uri="b"/></catalog>');
	assert.equal(byId(await collectChecks(context, deps)).catalog.status, "warn");
	deps.fs.rmSync(catalogPath(deps));
	assert.equal(byId(await collectChecks(context, deps)).catalog.status, "fail");
});

test("untrusted project-only config fails the trust check; a global registration does not", async () => {
	const { deps, context } = setup();
	const untrusted = { ...context, isProjectTrusted: false };
	assert.equal(byId(await collectChecks(untrusted, deps)).trust.status, "fail");
	const globalPath = join(makeTmp(), "global.json");
	deps.env.PI_LENS_CONFIG_PATH = globalPath;
	applyServerEntry(globalPath, buildEntry({ mode: "global", command: shimPath(deps), catalog: catalogPath(deps) }), deps);
	assert.equal(byId(await collectChecks(untrusted, deps)).trust.status, "ok");
});

test("a shim pointing at another install warns; a dangling shim fails", async () => {
	const { deps, context } = setup();
	const other = makeTmp("other-pkg-");
	writeFile(join(other, "bin/mule-xml-lsp"), "x");
	writeFile(shimPath(deps), `# generated-by: pi-mulesoft-lsp 1\nPKG='${other}'\n`);
	assert.equal(byId(await collectChecks(context, deps)).shim.status, "warn");
	writeFile(shimPath(deps), "# generated-by: pi-mulesoft-lsp 1\nPKG='/gone'\n");
	assert.equal(byId(await collectChecks(context, deps)).shim.status, "fail");
});

test("legacy toolkit, unregistered server and missing pi-lens are reported", async () => {
	const { deps, context } = setup();
	writeFile(shimPath(deps), "#!/bin/bash\nlegacy\n");
	deps.fs.rmSync(join(context.cwd, ".pi-lens.json"));
	const noLens = { ...context, toolNames: [], settingsPackages: [] };
	const items = byId(await collectChecks(noLens, deps));
	assert.equal(items.legacy.status, "warn");
	assert.equal(items.config.status, "warn");
	assert.equal(items.pilens.status, "fail");
	const listed = byId(await collectChecks({ ...noLens, settingsPackages: ["git:github.com/apmantza/pi-lens"] }, deps));
	assert.equal(listed.pilens.status, "warn");
});

test("config whose command or catalog is gone is a failure", async () => {
	const { deps, context } = setup();
	deps.fs.rmSync(catalogPath(deps));
	const items = byId(await collectChecks(context, deps));
	assert.equal(items.config.status, "fail");
	assert.match(items.config.detail, /catalog missing/);
});

test("formatReport marks statuses and lists unique next steps", async () => {
	const { deps, context } = setup();
	deps.fs.rmSync(catalogPath(deps));
	const report = formatReport(await collectChecks({ ...context, toolNames: [] }, deps));
	assert.match(report, /^pi-mulesoft-lsp doctor \(v0\.1\.0/);
	assert.match(report, /✓ Mule project — /);
	assert.match(report, /✗ Schema catalog — missing: /);
	assert.match(report, /\nNext:\n {2}- Run \/mule-lsp catalog/);
	assert.equal(report.split("Run /mule-lsp catalog").length - 1, 1);
});

test("a dangling .xsd symlink does not make doctor throw", async () => {
	const { deps, context, connectors } = setup();
	symlinkSync(join(connectors, "missing-target.xsd"), join(connectors, "http/1.0/broken.xsd"));
	const items = byId(await collectChecks(context, deps));
	assert.ok(items.freshness);
	assert.equal(items.freshness.status, "ok");
});
