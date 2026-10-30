import * as realFs from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Env = Record<string, string | undefined>;

export type FsLike = Pick<
	typeof realFs,
	| "existsSync"
	| "readFileSync"
	| "writeFileSync"
	| "renameSync"
	| "statSync"
	| "mkdirSync"
	| "realpathSync"
	| "readdirSync"
	| "chmodSync"
	| "copyFileSync"
	| "rmSync"
>;

/** Everything environment-dependent is injected so tests never touch the real home or agent dir. */
export interface Deps {
	fs: FsLike;
	env: Env;
	home: string;
}

export function defaultDeps(): Deps {
	return { fs: realFs, env: process.env, home: homedir() };
}

function expandHome(path: string, home: string): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return join(home, path.slice(2));
	return path;
}

/** `PI_CODING_AGENT_DIR` (with `~` expanded) or `~/.pi/agent`, same as pi-multi-accounts. */
export function agentDir(deps: Pick<Deps, "env" | "home">): string {
	const configured = deps.env.PI_CODING_AGENT_DIR?.trim();
	return configured ? resolve(expandHome(configured, deps.home)) : join(deps.home, ".pi", "agent");
}

/** Stable, package-independent state directory: catalog, XSDs and the launcher shim live here. */
export function dataDir(deps: Pick<Deps, "env" | "home">): string {
	const override = deps.env.MULE_LSP_DATA_DIR?.trim();
	return override ? resolve(expandHome(override, deps.home)) : join(agentDir(deps), "mulesoft-lsp");
}

export const catalogPath = (deps: Pick<Deps, "env" | "home">): string => join(dataDir(deps), "xsd", "catalog.xml");
export const shimPath = (deps: Pick<Deps, "env" | "home">): string => join(dataDir(deps), "bin", "mule-xml-lsp");

/** Directory of this package, located from this file (works for npm, git, local and `pi -e` installs). */
export function packageDir(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export function packageVersion(fs: FsLike = realFs): string {
	try {
		const manifest = JSON.parse(fs.readFileSync(join(packageDir(), "package.json"), "utf8")) as { version?: string };
		return manifest.version ?? "unknown";
	} catch {
		return "unknown";
	}
}
