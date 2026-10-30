import { join } from "node:path";
import { findMuleServer, SERVER_ID } from "./lens-config.ts";
import type { FoundServer } from "./lens-config.ts";
import { inspectShim, hasLegacyToolkit, runCheck } from "./install.ts";
import type { CheckResult, Runner } from "./install.ts";
import { catalogPath, dataDir, packageDir, packageVersion, shimPath } from "./paths.ts";
import type { Deps } from "./paths.ts";
import { findMuleRoot } from "./project.ts";

export type Status = "ok" | "warn" | "fail";

export interface Item {
	id: string;
	status: Status;
	label: string;
	detail: string;
	hint?: string;
}

export interface DoctorContext {
	cwd: string;
	isProjectTrusted: boolean;
	toolNames: string[];
	settingsPackages: string[];
}

export interface DoctorDeps extends Deps {
	runner: Runner;
}

const MAX_WALK_ENTRIES = 20_000;

const item = (id: string, status: Status, label: string, detail: string, hint?: string): Item => ({ id, status, label, detail, hint });

function studioPlugins(deps: Deps): string {
	const studio = deps.env.MULE_LSP_STUDIO ?? "/Applications/AnypointStudio.app";
	return join(studio, "Contents", "Eclipse", "plugins");
}

function connectorRoot(deps: Deps): string {
	return deps.env.MULE_LSP_CONNECTOR_XSD_ROOT ?? join(deps.home, "AnypointStudio", "studio-workspace", ".mule", "plugins-tmp", "repository");
}

/** Newest mtime (ms) of any *.xsd under `root`, bounded so a huge cache cannot stall the command. */
function newestXsdMtime(root: string, deps: Deps): number {
	let newest = 0;
	let seen = 0;
	const stack = [root];
	while (stack.length > 0 && seen < MAX_WALK_ENTRIES) {
		const dir = stack.pop() as string;
		let entries;
		try {
			entries = deps.fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			seen++;
			const path = join(dir, entry.name);
			if (entry.isDirectory()) stack.push(path);
			else if (entry.name.endsWith(".xsd")) {
				try {
					newest = Math.max(newest, deps.fs.statSync(path).mtimeMs);
				} catch {
					continue; // e.g. a dangling symlink
				}
			}
		}
	}
	return newest;
}

function newestRuntimeMtime(deps: Deps): number {
	try {
		const dirs = deps.fs
			.readdirSync(studioPlugins(deps))
			.filter((name) => /^org\.mule\.tooling\.server\.4\..*\.ee_/.test(name))
			.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
		const latest = dirs.at(-1);
		return latest ? deps.fs.statSync(join(studioPlugins(deps), latest)).mtimeMs : 0;
	} catch {
		return 0;
	}
}

function checkItem(id: string, label: string, check: CheckResult, keys: string[], hintText: string): Item {
	const missing = check.missing.filter((line) => keys.some((key) => line.startsWith(`${key}:`)));
	if (missing.length > 0) return item(id, "fail", label, missing.join("; "), hintText);
	const found = keys.filter((key) => check.values[key]).map((key) => `${key}=${check.values[key]}`);
	if (found.length === 0) return item(id, "fail", label, "not reported by --check", hintText);
	return item(id, "ok", label, found.join(", "));
}

function toolchainItems(check: CheckResult): Item[] {
	const studioHint = "Install Anypoint Studio or set MULE_LSP_STUDIO";
	return [
		checkItem("studio", "Anypoint Studio", check, ["studio"], studioHint),
		checkItem("jdk", "JDK 17", check, ["java_home"], "Set MULE_LSP_JAVA_HOME or MULE_LSP_STUDIO"),
		checkItem("devjar", "Mule DX dev jar", check, ["dev_jar"], "Install the Mule DX VS Code extension or set MULE_LSP_VSCODE_EXT"),
		checkItem(
			"jars",
			"Studio support jars",
			check,
			["jar.lsp4j", "jar.lsp4j.jsonrpc", "jar.gson", "jar.guava", "jar.failureaccess"],
			"Set MULE_LSP_STUDIO to the Anypoint Studio .app path",
		),
	];
}

function catalogItem(deps: Deps): Item {
	const path = catalogPath(deps);
	const label = "Schema catalog";
	if (!deps.fs.existsSync(path)) return item("catalog", "fail", label, `missing: ${path}`, "Run /mule-lsp catalog");
	const text = deps.fs.readFileSync(path, "utf8");
	const entries = text.split("<system ").length - 1;
	if (entries === 0) return item("catalog", "fail", label, `${path} has no entries`, "Run /mule-lsp catalog");
	if (!text.includes("http/current/mule-http.xsd")) {
		return item("catalog", "warn", label, `${entries} entries, but no http/current/mule-http.xsd`, "Open a Mule project in Studio once, then /mule-lsp catalog");
	}
	return item("catalog", "ok", label, `${entries} entries (${path})`);
}

function freshnessItem(deps: Deps): Item {
	const path = catalogPath(deps);
	const label = "Catalog freshness";
	if (!deps.fs.existsSync(path)) return item("freshness", "warn", label, "no catalog to compare", "Run /mule-lsp catalog");
	const built = deps.fs.statSync(path).mtimeMs;
	const sourceNewest = Math.max(newestXsdMtime(connectorRoot(deps), deps), newestRuntimeMtime(deps));
	if (sourceNewest > built) return item("freshness", "warn", label, "Studio sources are newer than the catalog", "Run /mule-lsp catalog");
	return item("freshness", "ok", label, "up to date with Studio sources");
}

function lensItem(context: DoctorContext): Item {
	if (context.toolNames.includes("lens_diagnostics")) return item("pilens", "ok", "pi-lens", "loaded (lens_diagnostics available)");
	if (context.settingsPackages.some((name) => name.includes("pi-lens"))) {
		return item("pilens", "warn", "pi-lens", "listed in settings but not loaded in this session", "Run /reload");
	}
	return item("pilens", "fail", "pi-lens", "not found", "Install pi-lens (pi install git:github.com/apmantza/pi-lens)");
}

function describeServer(scope: string, found: FoundServer | undefined, deps: Deps): { text: string; isBroken: boolean } {
	if (!found) return { text: `${scope}: not registered`, isBroken: false };
	const command = typeof found.entry.command === "string" ? found.entry.command : undefined;
	const isCommandMissing = !command || !deps.fs.existsSync(command);
	const catalogs = JSON.stringify(found.entry.initializationOptions ?? {}).match(/"([^"]+catalog\.xml)"/g) ?? [];
	const isCatalogMissing = catalogs.some((quoted) => !deps.fs.existsSync(quoted.slice(1, -1)));
	const problems = [isCommandMissing ? "command missing" : "", isCatalogMissing ? "catalog missing" : ""].filter(Boolean);
	const state = problems.length > 0 ? problems.join(", ") : "ok";
	return { text: `${scope}: ${found.path} (${state})`, isBroken: problems.length > 0 };
}

function configItem(context: DoctorContext, deps: Deps): Item {
	const found = findMuleServer(context.cwd, deps);
	const project = describeServer("project", found.project, deps);
	const global = describeServer("global", found.global, deps);
	const detail = `${project.text}\n${global.text}`;
	const label = "pi-lens config";
	if (project.isBroken || global.isBroken) {
		return item("config", "fail", label, detail, "Re-run /mule-lsp init (and /mule-lsp catalog if the catalog is missing)");
	}
	if (!found.project && !found.global) return item("config", "warn", label, detail, "Run /mule-lsp init (or /mule-lsp init --global)");
	return item("config", "ok", label, detail);
}

function trustItem(context: DoctorContext, deps: Deps): Item {
	const found = findMuleServer(context.cwd, deps);
	const isProjectOnly = Boolean(found.project) && !found.global;
	const label = "Project trust";
	if (isProjectOnly && !context.isProjectTrusted) {
		return item("trust", "fail", label, "project config is not trusted, pi-lens will refuse the LSP command", "Run /trust, then /reload");
	}
	return item("trust", "ok", label, context.isProjectTrusted ? "trusted" : "not needed (no project-only config)");
}

function shimItem(deps: Deps): Item {
	const info = inspectShim(deps);
	const label = "Launcher shim";
	const hint = "Run /mule-lsp init";
	if (!info.exists) return item("shim", "fail", label, `missing: ${shimPath(deps)}`, hint);
	if (!info.isGenerated) return item("shim", "warn", label, "legacy script (not generated by pi-mulesoft-lsp)", hint);
	if (!info.isTargetValid) return item("shim", "fail", label, `points to a missing package: ${info.target}`, hint);
	if (!info.isCurrentPackage) {
		return item("shim", "warn", label, `points to another install: ${info.target} (running ${packageDir()})`, "Run /mule-lsp init to point it at this install");
	}
	return item("shim", "ok", label, `${info.path} -> ${info.target}`);
}

function legacyItem(deps: Deps): Item {
	const label = "Legacy toolkit";
	if (hasLegacyToolkit(deps)) {
		return item("legacy", "warn", label, `old scripts still in ${dataDir(deps)}`, "Run /mule-lsp init to move them to legacy-toolkit-*");
	}
	return item("legacy", "ok", label, "none");
}

export async function collectChecks(context: DoctorContext, deps: DoctorDeps): Promise<Item[]> {
	const muleRoot = findMuleRoot(context.cwd, deps);
	const info = inspectShim(deps);
	const wrapper = info.isGenerated && info.isTargetValid ? info.path : join(packageDir(), "bin", "mule-xml-lsp");
	const check = await runCheck(deps.runner, deps, wrapper);
	return [
		muleRoot
			? item("project", "ok", "Mule project", muleRoot)
			: item("project", "warn", "Mule project", `no mule-artifact.json above ${context.cwd}`, "cd into a Mule project to get diagnostics there"),
		...toolchainItems(check),
		catalogItem(deps),
		freshnessItem(deps),
		lensItem(context),
		configItem(context, deps),
		trustItem(context, deps),
		shimItem(deps),
		legacyItem(deps),
	];
}

const MARKS: Record<Status, string> = { ok: "✓", warn: "!", fail: "✗" };

export function worstStatus(items: Item[]): Status {
	if (items.some((entry) => entry.status === "fail")) return "fail";
	return items.some((entry) => entry.status === "warn") ? "warn" : "ok";
}

export function formatReport(items: Item[]): string {
	const lines = [`pi-mulesoft-lsp doctor (v${packageVersion()}, server id ${SERVER_ID})`];
	for (const entry of items) {
		const [first, ...rest] = entry.detail.split("\n");
		lines.push(`${MARKS[entry.status]} ${entry.label} — ${first}`, ...rest.map((line) => `    ${line}`));
	}
	const hints = [...new Set(items.filter((entry) => entry.status !== "ok" && entry.hint).map((entry) => entry.hint as string))];
	if (hints.length > 0) lines.push("", "Next:", ...hints.map((hint) => `  - ${hint}`));
	return lines.join("\n");
}
