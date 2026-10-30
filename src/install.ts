import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { dataDir, packageDir, shimPath } from "./paths.ts";
import type { Deps, Env } from "./paths.ts";

export const SHIM_MARKER = "# generated-by: pi-mulesoft-lsp";
const LEGACY_ITEMS = ["bin", "test", "README.md", "package.json"];

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}
export type Runner = (cmd: string, args: string[], options: { env: Env; timeout: number }) => Promise<RunResult>;

/** Never rejects: failures come back as a non-zero `code`. */
export const defaultRunner: Runner = (cmd, args, { env, timeout }) =>
	new Promise((resolvePromise) => {
		execFile(cmd, args, { env: env as NodeJS.ProcessEnv, timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
			const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
			resolvePromise({ code, stdout: String(stdout), stderr: String(stderr) });
		});
	});

export function hasWhitespace(path: string): boolean {
	return /\s/.test(path);
}

// ---------------------------------------------------------------- launcher shim

export function renderShim(options: { pkg: string; node: string; version: string }): string {
	const { pkg, node, version } = options;
	if (pkg.includes("'") || node.includes("'")) throw new Error("package or node path contains a single quote");
	return [
		"#!/usr/bin/env bash",
		`${SHIM_MARKER} ${version} — do not edit; re-run /mule-lsp init`,
		`PKG='${pkg}'`,
		`NODE='${node}'`,
		'[ -f "$PKG/bin/mule-xml-lsp" ] || { echo "mule-xml-lsp shim: package not found at $PKG; run /mule-lsp init in pi" >&2; exit 1; }',
		'[ -x "$NODE" ] && export MULE_LSP_NODE="$NODE"',
		'exec bash "$PKG/bin/mule-xml-lsp" "$@"',
		"",
	].join("\n");
}

export const isGeneratedShim = (text: string): boolean => text.includes(SHIM_MARKER);

export function readShimTarget(text: string): string | undefined {
	return /^PKG='(.*)'$/m.exec(text)?.[1];
}

export type ShimStatus = "written" | "unchanged";

/** Write the launcher shim atomically (tmp + rename, mode 0755). Idempotent. */
export function ensureShim(deps: Deps, options: { node: string; version: string }): { path: string; status: ShimStatus } {
	const { fs } = deps;
	const path = shimPath(deps);
	const text = renderShim({ pkg: packageDir(), node: options.node, version: options.version });
	const current = fs.existsSync(path) ? fs.readFileSync(path, "utf8") : undefined;
	if (current === text) return { path, status: "unchanged" };
	fs.mkdirSync(dirname(path), { recursive: true });
	const tmpPath = `${path}.${process.pid}.tmp`;
	fs.writeFileSync(tmpPath, text, { mode: 0o755 });
	fs.chmodSync(tmpPath, 0o755);
	fs.renameSync(tmpPath, path);
	return { path, status: "written" };
}

export interface ShimInfo {
	path: string;
	exists: boolean;
	isGenerated: boolean;
	target?: string;
	isTargetValid: boolean;
	isCurrentPackage: boolean;
}

export function inspectShim(deps: Deps): ShimInfo {
	const { fs } = deps;
	const path = shimPath(deps);
	if (!fs.existsSync(path)) return { path, exists: false, isGenerated: false, isTargetValid: false, isCurrentPackage: false };
	const text = fs.readFileSync(path, "utf8");
	const isGenerated = isGeneratedShim(text);
	const target = isGenerated ? readShimTarget(text) : undefined;
	const isTargetValid = target !== undefined && fs.existsSync(join(target, "bin", "mule-xml-lsp"));
	return { path, exists: true, isGenerated, target, isTargetValid, isCurrentPackage: target === packageDir() };
}

// ---------------------------------------------------------------- legacy migration

/** True when the data dir still holds the pre-package toolkit (a non-generated bin/mule-xml-lsp). */
export function hasLegacyToolkit(deps: Deps): boolean {
	const path = shimPath(deps);
	return deps.fs.existsSync(path) && !isGeneratedShim(deps.fs.readFileSync(path, "utf8"));
}

function pickLegacyDir(root: string, deps: Deps, now: Date): string {
	const stamp = now.toISOString().slice(0, 10).replaceAll("-", "");
	const base = join(root, `legacy-toolkit-${stamp}`);
	let candidate = base;
	for (let n = 2; deps.fs.existsSync(candidate); n++) candidate = `${base}-${n}`;
	return candidate;
}

/** Move (never delete) the old toolkit files into `legacy-toolkit-YYYYMMDD/`. `xsd/` stays in place. */
export function migrateLegacy(deps: Deps, now: Date = new Date()): string[] {
	if (!hasLegacyToolkit(deps)) return [];
	const root = dataDir(deps);
	const target = pickLegacyDir(root, deps, now);
	deps.fs.mkdirSync(target, { recursive: true });
	const moved: string[] = [];
	for (const item of LEGACY_ITEMS) {
		if (!deps.fs.existsSync(join(root, item))) continue;
		deps.fs.renameSync(join(root, item), join(target, item));
		moved.push(item);
	}
	return moved;
}

// ---------------------------------------------------------------- bash script runners

export interface CatalogResult {
	ok: boolean;
	core?: number;
	connectors?: number;
	entries?: number;
	out?: string;
	warnings: string[];
	stderr: string;
}

export function parseCatalogOutput(result: RunResult): CatalogResult {
	const lines = result.stderr.split("\n");
	const warnings = lines.filter((line) => line.startsWith("WARN: ")).map((line) => line.slice(6));
	const summary = lines.find((line) => line.startsWith("summary "));
	const field = (key: string): string | undefined => new RegExp(`${key}=(\\S+)`).exec(summary ?? "")?.[1];
	return {
		ok: result.code === 0,
		core: summary ? Number(field("core")) : undefined,
		connectors: summary ? Number(field("connectors")) : undefined,
		entries: summary ? Number(field("entries")) : undefined,
		out: field("out"),
		warnings,
		stderr: result.stderr,
	};
}

export async function runCatalog(runner: Runner, deps: Deps): Promise<CatalogResult> {
	const script = join(packageDir(), "bin", "mule-xsd-catalog");
	const env = { ...deps.env, MULE_LSP_DATA_DIR: dataDir(deps) };
	return parseCatalogOutput(await runner("bash", [script], { env, timeout: 180_000 }));
}

export interface CheckResult {
	ok: boolean;
	values: Record<string, string>;
	missing: string[];
	stderr: string;
}

export function parseCheckOutput(result: RunResult): CheckResult {
	const values: Record<string, string> = {};
	const missing: string[] = [];
	for (const line of result.stderr.split("\n")) {
		const match = /^([a-z0-9_.]+)=(.*)$/.exec(line);
		if (!match) continue;
		if (match[1] === "missing") missing.push(match[2]);
		else values[match[1]] = match[2];
	}
	return { ok: result.code === 0, values, missing, stderr: result.stderr };
}

/** Runs `<wrapper> --check` (the generated shim or the package's own wrapper). */
export async function runCheck(runner: Runner, deps: Deps, wrapper: string): Promise<CheckResult> {
	return parseCheckOutput(await runner("bash", [wrapper, "--check"], { env: deps.env, timeout: 30_000 }));
}
