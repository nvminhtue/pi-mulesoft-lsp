import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import {
	defaultRunner,
	ensureShim,
	hasLegacyToolkit,
	inspectShim,
	migrateLegacy,
	parseCatalogOutput,
	parseCheckOutput,
	readShimTarget,
	renderShim,
	runCatalog,
	runCheck,
} from "../src/install.ts";
import { dataDir, packageDir, shimPath } from "../src/paths.ts";
import { makeDeps, makeTmp, writeFile } from "./helpers/deps.mjs";

const isolated = () => makeDeps({ env: { PI_CODING_AGENT_DIR: makeTmp("agent-") } });
const NOW = new Date("2026-05-02T10:00:00Z");

test("renderShim/readShimTarget round-trip and reject single quotes", () => {
	const text = renderShim({ pkg: "/opt/pkg", node: "/usr/bin/node", version: "1.2.3" });
	assert.equal(readShimTarget(text), "/opt/pkg");
	assert.match(text, /^# generated-by: pi-mulesoft-lsp 1\.2\.3/m);
	assert.throws(() => renderShim({ pkg: "/o'pkg", node: "/n", version: "1" }), /single quote/);
});

test("the shim execs the package wrapper with its arguments and exports MULE_LSP_NODE", () => {
	const pkg = makeTmp("pkg-");
	writeFile(join(pkg, "bin/mule-xml-lsp"), '#!/usr/bin/env bash\necho "args=$* node=$MULE_LSP_NODE" >&2\n');
	const shim = join(makeTmp(), "shim");
	writeFile(shim, renderShim({ pkg, node: process.execPath, version: "1" }));
	const result = spawnSync("bash", [shim, "--check", "x"], { encoding: "utf8" });
	assert.equal(result.status, 0);
	assert.equal(result.stdout, "");
	assert.equal(result.stderr.trim(), `args=--check x node=${process.execPath}`);
});

test("the shim fails clearly (exit 1, empty stdout) when its package is gone", () => {
	const shim = join(makeTmp(), "shim");
	writeFile(shim, renderShim({ pkg: "/nonexistent/pkg", node: "/nonexistent/node", version: "1" }));
	const result = spawnSync("bash", [shim], { encoding: "utf8" });
	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /package not found at \/nonexistent\/pkg/);
});

test("ensureShim writes an executable shim atomically and is idempotent", () => {
	const deps = isolated();
	const first = ensureShim(deps, { node: process.execPath, version: "0.1.0" });
	assert.equal(first.status, "written");
	assert.equal(first.path, shimPath(deps));
	assert.equal(statSync(first.path).mode & 0o777, 0o755);
	assert.equal(readShimTarget(readFileSync(first.path, "utf8")), packageDir());
	assert.equal(ensureShim(deps, { node: process.execPath, version: "0.1.0" }).status, "unchanged");
	assert.deepEqual(readdirSync(join(dataDir(deps), "bin")), ["mule-xml-lsp"]);
});

test("inspectShim classifies missing, legacy, dangling, foreign and current shims", () => {
	const deps = isolated();
	assert.equal(inspectShim(deps).exists, false);
	writeFile(shimPath(deps), "#!/bin/bash\nold\n");
	assert.deepEqual([inspectShim(deps).exists, inspectShim(deps).isGenerated], [true, false]);
	writeFile(shimPath(deps), renderShim({ pkg: "/gone", node: "/n", version: "1" }));
	assert.deepEqual([inspectShim(deps).isGenerated, inspectShim(deps).isTargetValid], [true, false]);
	const foreign = makeTmp("pkg-");
	writeFile(join(foreign, "bin/mule-xml-lsp"), "x");
	writeFile(shimPath(deps), renderShim({ pkg: foreign, node: "/n", version: "1" }));
	assert.deepEqual([inspectShim(deps).isTargetValid, inspectShim(deps).isCurrentPackage], [true, false]);
	ensureShim(deps, { node: "/n", version: "1" });
	assert.equal(inspectShim(deps).isCurrentPackage, true);
});

function seedLegacy(deps) {
	const root = dataDir(deps);
	writeFile(join(root, "bin/mule-xml-lsp"), "#!/usr/bin/env bash\nlegacy\n");
	writeFile(join(root, "bin/mule-xsd-catalog"), "legacy");
	writeFile(join(root, "test/run-tests.sh"), "legacy");
	writeFile(join(root, "README.md"), "legacy");
	writeFile(join(root, "package.json"), "{}");
	writeFile(join(root, "xsd/catalog.xml"), "<catalog/>");
	return root;
}

test("migrateLegacy moves (never deletes) the four legacy items and keeps xsd/", () => {
	const deps = isolated();
	const root = seedLegacy(deps);
	assert.equal(hasLegacyToolkit(deps), true);
	assert.deepEqual(migrateLegacy(deps, NOW), ["bin", "test", "README.md", "package.json"]);
	const legacy = join(root, "legacy-toolkit-20260502");
	assert.equal(readFileSync(join(legacy, "bin/mule-xml-lsp"), "utf8").includes("legacy"), true);
	assert.equal(existsSync(join(legacy, "test/run-tests.sh")), true);
	assert.equal(existsSync(join(root, "bin")), false);
	assert.equal(readFileSync(join(root, "xsd/catalog.xml"), "utf8"), "<catalog/>");
});

test("migrateLegacy adds a suffix when the target name is taken and ignores generated shims", () => {
	const deps = isolated();
	const root = seedLegacy(deps);
	mkdirSync(join(root, "legacy-toolkit-20260502"));
	migrateLegacy(deps, NOW);
	assert.equal(existsSync(join(root, "legacy-toolkit-20260502-2/bin/mule-xml-lsp")), true);
	ensureShim(deps, { node: "/n", version: "1" });
	assert.equal(hasLegacyToolkit(deps), false);
	assert.deepEqual(migrateLegacy(deps, NOW), []);
	assert.equal(existsSync(shimPath(deps)), true);
});

test("parseCatalogOutput reads the summary line and warnings", () => {
	const stderr = "runtime: x\nWARN: no local file for http://a/b.xsd\nsummary core=12 connectors=34 entries=56 out=/d/xsd\n";
	const parsed = parseCatalogOutput({ code: 0, stdout: "", stderr });
	assert.deepEqual([parsed.ok, parsed.core, parsed.connectors, parsed.entries, parsed.out], [true, 12, 34, 56, "/d/xsd"]);
	assert.deepEqual(parsed.warnings, ["no local file for http://a/b.xsd"]);
	assert.equal(parseCatalogOutput({ code: 1, stdout: "", stderr: "ERROR" }).ok, false);
});

test("runCatalog runs the packaged script with MULE_LSP_DATA_DIR set", async () => {
	const deps = isolated();
	let call;
	const runner = async (cmd, args, options) => {
		call = { cmd, args, options };
		return { code: 0, stdout: "", stderr: "summary core=1 connectors=2 entries=3 out=/x\n" };
	};
	const result = await runCatalog(runner, deps);
	assert.equal(call.cmd, "bash");
	assert.equal(call.args[0], join(packageDir(), "bin/mule-xsd-catalog"));
	assert.equal(call.options.env.MULE_LSP_DATA_DIR, dataDir(deps));
	assert.equal(result.entries, 3);
});

test("parseCheckOutput/runCheck split key=value lines from missing= lines", async () => {
	const stderr = "java_home=/j\nstudio=/s\nmissing=jar.gson: not found\nnoise\n";
	const runner = async (cmd, args) => ({ code: 1, stdout: "", stderr, args });
	const check = await runCheck(runner, isolated(), "/shim");
	assert.equal(check.ok, false);
	assert.deepEqual(check.values, { java_home: "/j", studio: "/s" });
	assert.deepEqual(check.missing, ["jar.gson: not found"]);
	assert.equal(parseCheckOutput({ code: 0, stdout: "", stderr: "" }).ok, true);
});

test("defaultRunner reports exit codes and output without rejecting", async () => {
	const result = await defaultRunner("bash", ["-c", "echo out; echo err >&2; exit 3"], { env: process.env, timeout: 10_000 });
	assert.deepEqual([result.code, result.stdout.trim(), result.stderr.trim()], [3, "out", "err"]);
	const missing = await defaultRunner("/nonexistent-binary", [], { env: process.env, timeout: 10_000 });
	assert.notEqual(missing.code, 0);
});
