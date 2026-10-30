import * as fs from "node:fs";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const makeTmp = (prefix = "pi-mulesoft-lsp-") => fs.realpathSync(mkdtempSync(join(tmpdir(), prefix)));

/** Isolated deps: a fake HOME and an env that never sees the developer's real pi/pi-lens settings. */
export function makeDeps(overrides = {}) {
	const home = overrides.home ?? makeTmp("mule-home-");
	const env = { PATH: process.env.PATH, ...overrides.env };
	return { fs, env, home, ...(overrides.fs ? { fs: overrides.fs } : {}) };
}

export function writeFile(path, text) {
	mkdirSync(join(path, ".."), { recursive: true });
	fs.writeFileSync(path, text);
}

export const readJson = (path) => JSON.parse(fs.readFileSync(path, "utf8"));
