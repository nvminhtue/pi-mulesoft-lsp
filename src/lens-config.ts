import { dirname, join, resolve } from "node:path";
import type { Deps } from "./paths.ts";

export const SERVER_ID = "mule-xml";
export const PROJECT_CONFIG_FILE = ".pi-lens.json";
export const REQUIRE_MARKER_ENV = "MULE_LSP_REQUIRE_MARKER";

export type ServerMode = "project" | "global";

export interface MuleServerEntry {
	name: string;
	extensions: string[];
	command: string;
	args: string[];
	rootMarkers: string[];
	initializationOptions: { settings: { xml: { catalogs: string[] } }; xml: { catalogs: string[] } };
	env?: Record<string, string>;
}

export type GlobalConfigSource =
	| "pi-lens-config-path"
	| "legacy-default-existing"
	| "legacy-default-unprobed"
	| "pi-coding-agent-dir"
	| "pi-coding-agent-dir-unprobed"
	| "canonical-default";

export interface GlobalConfigResolution {
	path: string;
	source: GlobalConfigSource;
	probeError?: string;
}

function isFile(path: string, deps: Pick<Deps, "fs">): boolean {
	try {
		return deps.fs.statSync(path).isFile();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

/**
 * Port of pi-lens `resolveGlobalConfigLocation` (clients/config-locations.ts): which file supplies the
 * machine-global tier. A probe error other than ENOENT keeps its tier (fail closed) and is reported.
 */
export function resolveGlobalLensConfig(deps: Pick<Deps, "fs" | "env" | "home">): GlobalConfigResolution {
	const override = deps.env.PI_LENS_CONFIG_PATH;
	if (override) return { path: resolve(override), source: "pi-lens-config-path" };

	const legacyDefault = join(deps.home, ".pi-lens", "config.json");
	const agentDirEnv = deps.env.PI_CODING_AGENT_DIR?.trim();
	const agentPath = agentDirEnv ? join(resolve(agentDirEnv), "extensions", "pi-lens.json") : undefined;

	try {
		if (isFile(legacyDefault, deps)) return { path: legacyDefault, source: "legacy-default-existing" };
	} catch (error) {
		return { path: legacyDefault, source: "legacy-default-unprobed", probeError: (error as Error).message };
	}
	if (agentPath) {
		try {
			if (isFile(agentPath, deps)) return { path: agentPath, source: "pi-coding-agent-dir" };
		} catch (error) {
			return { path: agentPath, source: "pi-coding-agent-dir-unprobed", probeError: (error as Error).message };
		}
	}
	return { path: legacyDefault, source: "canonical-default" };
}

/** `.pi-lens.json` files from `cwd` upwards (nearest first), never at or above `$HOME`. */
export function findProjectLensConfigs(cwd: string, deps: Pick<Deps, "fs" | "home">): string[] {
	const home = resolve(deps.home);
	const found: string[] = [];
	let dir = resolve(cwd);
	for (;;) {
		if (dir === home) break;
		const candidate = join(dir, PROJECT_CONFIG_FILE);
		if (deps.fs.existsSync(candidate)) found.push(candidate);
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return found;
}

export function buildEntry(options: { mode: ServerMode; command: string; catalog: string }): MuleServerEntry {
	const xml = { catalogs: [options.catalog] };
	const entry: MuleServerEntry = {
		name: "MuleSoft XML (LemMinX)",
		extensions: [".xml"],
		command: options.command,
		args: [],
		rootMarkers: ["mule-artifact.json"],
		// pi-lens sends the blob as initializationOptions AND as didChangeConfiguration.settings;
		// LemMinX reads settings.xml at init but params.settings.xml on DCC, so provide both shapes.
		initializationOptions: { settings: { xml }, xml },
	};
	if (options.mode === "global") entry.env = { [REQUIRE_MARKER_ENV]: "1" };
	return entry;
}

export type MergeResult =
	| { ok: true; output: string; changed: boolean }
	| { ok: false; reason: string; manual: string };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

/** Pure merge of the mule-xml entry into existing config text (undefined = no file yet). */
export function mergeServerEntry(text: string | undefined, entry: MuleServerEntry): MergeResult {
	const manual = JSON.stringify(entry, null, 2);
	const refuse = (reason: string): MergeResult => ({ ok: false, reason: `${reason} Not modified.`, manual });
	let config: unknown = {};
	if (text !== undefined) {
		try {
			config = JSON.parse(text);
		} catch (error) {
			return refuse(`Config is not strict JSON (${(error as Error).message}).`);
		}
	}
	if (!isPlainObject(config)) return refuse("Config must contain a JSON object at the top level.");
	const lsp = config.lsp ?? {};
	if (!isPlainObject(lsp)) return refuse('"lsp" must be a JSON object.');
	const servers = lsp.servers ?? {};
	if (!isPlainObject(servers)) return refuse('"lsp.servers" must be a JSON object.');
	config.lsp = lsp;
	lsp.servers = servers;
	servers[SERVER_ID] = entry;
	const output = `${JSON.stringify(config, null, 2)}\n`;
	return { ok: true, output, changed: text !== output };
}

export type ApplyResult =
	| { status: "written" | "unchanged"; path: string; backedUp: boolean }
	| { status: "refused"; path: string; reason: string; manual: string };

/** Read, merge and atomically write `configPath`; `.bak` only when content changes and none exists yet. */
export function applyServerEntry(configPath: string, entry: MuleServerEntry, deps: Pick<Deps, "fs">): ApplyResult {
	const { fs } = deps;
	const isExisting = fs.existsSync(configPath);
	// Write next to the real target so a symlinked config stays a symlink.
	const targetPath = isExisting ? fs.realpathSync(configPath) : configPath;
	const existing = isExisting ? fs.readFileSync(targetPath, "utf8") : undefined;
	const merged = mergeServerEntry(existing, entry);
	if (!merged.ok) return { status: "refused", path: configPath, reason: merged.reason, manual: merged.manual };
	if (!merged.changed) return { status: "unchanged", path: configPath, backedUp: false };

	const backupPath = `${targetPath}.bak`;
	const shouldBackUp = existing !== undefined && !fs.existsSync(backupPath);
	if (shouldBackUp) fs.copyFileSync(targetPath, backupPath);
	fs.mkdirSync(dirname(targetPath), { recursive: true });
	const tmpPath = `${targetPath}.${process.pid}.tmp`;
	fs.writeFileSync(tmpPath, merged.output);
	fs.renameSync(tmpPath, targetPath);
	return { status: "written", path: configPath, backedUp: shouldBackUp };
}

export interface FoundServer {
	path: string;
	entry: Record<string, unknown>;
}

function readServerEntry(path: string, deps: Pick<Deps, "fs">): Record<string, unknown> | undefined {
	try {
		const config: unknown = JSON.parse(deps.fs.readFileSync(path, "utf8"));
		const lsp = isPlainObject(config) ? config.lsp : undefined;
		const servers = isPlainObject(lsp) ? lsp.servers : undefined;
		const entry = isPlainObject(servers) ? servers[SERVER_ID] : undefined;
		return isPlainObject(entry) ? entry : undefined;
	} catch {
		return undefined;
	}
}

/** Where a mule-xml server is already registered (unreadable or invalid files are skipped). */
export function findMuleServer(
	cwd: string,
	deps: Pick<Deps, "fs" | "env" | "home">,
): { project?: FoundServer; global?: FoundServer } {
	const result: { project?: FoundServer; global?: FoundServer } = {};
	for (const path of findProjectLensConfigs(cwd, deps)) {
		const entry = readServerEntry(path, deps);
		if (entry) {
			result.project = { path, entry };
			break;
		}
	}
	try {
		const globalPath = resolveGlobalLensConfig(deps).path;
		const entry = readServerEntry(globalPath, deps);
		if (entry) result.global = { path: globalPath, entry };
	} catch {
		// Unprobeable global config: treat as not registered.
	}
	return result;
}
