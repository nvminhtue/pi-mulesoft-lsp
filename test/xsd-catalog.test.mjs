import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { makeTmp, writeFile } from "./helpers/deps.mjs";

const SCRIPT = join(import.meta.dirname, "..", "bin", "mule-xsd-catalog");
const hasUnzip = spawnSync("sh", ["-c", "command -v unzip"]).status === 0;

function runCatalog({ failingMktemp = false } = {}) {
	const tmp = makeTmp("xsd-catalog-");
	const data = join(tmp, "data");
	const runtime = join(tmp, "runtime");
	mkdirSync(join(runtime, "mule/lib/mule"), { recursive: true });
	let path = process.env.PATH;
	if (failingMktemp) {
		const fakeBin = join(tmp, "fake-bin");
		writeFile(join(fakeBin, "mktemp"), "#!/bin/sh\nexit 1\n");
		chmodSync(join(fakeBin, "mktemp"), 0o755);
		path = `${fakeBin}:${path}`;
	}
	const env = { ...process.env, PATH: path, HOME: tmp, MULE_LSP_DATA_DIR: data, MULE_LSP_RUNTIME_DIR: runtime };
	const result = spawnSync("bash", [SCRIPT], { env, encoding: "utf8" });
	return { result, lock: join(data, "xsd.lock") };
}

test("catalog script releases its lock when mktemp fails right after locking", { skip: !hasUnzip }, () => {
	const { result, lock } = runCatalog({ failingMktemp: true });
	assert.notEqual(result.status, 0);
	assert.equal(existsSync(lock), false, `lock left behind; stderr: ${result.stderr}`);
});

test("catalog script releases its lock on a later failure (no XSDs in the runtime)", { skip: !hasUnzip }, () => {
	const { result, lock } = runCatalog();
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /no core XSDs extracted/);
	assert.equal(existsSync(lock), false);
});
