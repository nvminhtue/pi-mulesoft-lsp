import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { collectChecks, formatReport, worstStatus } from "./doctor.ts";
import type { DoctorContext, Status } from "./doctor.ts";
import { defaultRunner, ensureShim, hasWhitespace, migrateLegacy, runCatalog, runCheck } from "./install.ts";
import type { Runner } from "./install.ts";
import { PROJECT_CONFIG_FILE, applyServerEntry, buildEntry, resolveGlobalLensConfig } from "./lens-config.ts";
import type { ApplyResult, ServerMode } from "./lens-config.ts";
import { catalogPath, dataDir, defaultDeps, packageVersion, shimPath } from "./paths.ts";
import type { Deps } from "./paths.ts";
import { MULE_MARKER, findMuleRoot } from "./project.ts";

/** Everything the commands need from the outside world; injected in tests. */
export interface CommandServices extends Deps {
	runner: Runner;
	node: string;
	now: Date;
}

export function defaultServices(): CommandServices {
	return { ...defaultDeps(), runner: defaultRunner, node: process.execPath, now: new Date() };
}

export const HELP = [
	"/mule-lsp init [dir] [--global] [--yes]  register the Mule XML language server with pi-lens",
	"/mule-lsp catalog                         (re)generate the Mule schema catalog from Anypoint Studio",
	"/mule-lsp doctor                          check the whole setup",
	"/mule-lsp help                            this text",
].join("\n");

const COMPLETIONS = ["init", "init --global", "catalog", "doctor", "help"];

export function getCompletions(prefix: string): { value: string; label: string }[] | null {
	const matches = COMPLETIONS.filter((candidate) => candidate.startsWith(prefix.trimStart()));
	return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
}

export interface InitArgs {
	isGlobal: boolean;
	isConfirmed: boolean;
	dir?: string;
}

const INIT_FLAGS = ["--global", "--yes"];

/** Throws on any token starting with "-" that is not a known flag. */
export function parseInitArgs(tokens: string[]): InitArgs {
	const flags = tokens.filter((token) => token.startsWith("-"));
	const unknown = flags.filter((flag) => !INIT_FLAGS.includes(flag));
	if (unknown.length > 0) throw new Error(`unknown option ${unknown.join(", ")}. Usage: /mule-lsp init [dir] [--global] [--yes]`);
	const positional = tokens.filter((token) => !token.startsWith("-"));
	return { isGlobal: flags.includes("--global"), isConfirmed: flags.includes("--yes"), dir: positional[0] };
}

const LEVELS: Record<Status, "info" | "warning" | "error"> = { ok: "info", warn: "warning", fail: "error" };

function describeResult(result: ApplyResult): string {
	if (result.status === "refused") return `Refused to edit ${result.path}: ${result.reason}\nMerge this entry by hand under lsp.servers["mule-xml"]:\n${result.manual}`;
	if (result.status === "unchanged") return `lsp.servers["mule-xml"] already up to date in ${result.path}.`;
	return `Wrote lsp.servers["mule-xml"] to ${result.path}${result.backedUp ? " (backup: .bak)" : ""}.`;
}

function nextSteps(isGlobal: boolean): string {
	if (isGlobal) return "Next: restart pi (pi-lens fixes the global config location per process), then check /lens-health.";
	return "Next: run /trust for this project if you have not, then /reload (or restart pi) and check /lens-health.";
}

/** Decide where `init` writes; returns undefined when the user declined or the target is unusable. */
async function resolveTarget(args: InitArgs, ctx: ExtensionCommandContext, services: CommandServices): Promise<{ configPath: string; mode: ServerMode } | undefined> {
	if (args.isGlobal) return resolveGlobalTarget(args, ctx, services);
	const dir = args.dir ? resolve(ctx.cwd, args.dir) : (findMuleRoot(ctx.cwd, services) ?? ctx.cwd);
	if (!services.fs.existsSync(dir)) {
		ctx.ui.notify(`mule-lsp: directory not found: ${dir}`, "error");
		return undefined;
	}
	if (!services.fs.existsSync(join(dir, MULE_MARKER))) {
		const message = `No ${MULE_MARKER} in ${dir}; the server will not match this directory's rootMarkers.`;
		if (!ctx.hasUI) ctx.ui.notify(`mule-lsp: ${message}`, "warning");
		else if (!args.isConfirmed && !(await ctx.ui.confirm("Not a Mule project?", `${message}\nRegister anyway?`))) return undefined;
	}
	return { configPath: join(services.fs.realpathSync(dir), PROJECT_CONFIG_FILE), mode: "project" };
}

async function resolveGlobalTarget(args: InitArgs, ctx: ExtensionCommandContext, services: CommandServices): Promise<{ configPath: string; mode: ServerMode } | undefined> {
	const resolution = resolveGlobalLensConfig(services);
	if (resolution.probeError) {
		ctx.ui.notify(`mule-lsp: cannot probe pi-lens global config ${resolution.path}: ${resolution.probeError}. Not modified.`, "error");
		return undefined;
	}
	if (!args.isConfirmed) {
		if (!ctx.hasUI) {
			ctx.ui.notify("mule-lsp: init --global needs confirmation; re-run with --yes (no UI available).", "warning");
			return undefined;
		}
		const message = `Register the Mule server in ${resolution.path}?\nIt applies to every project; non-Mule XML files get a no-op server.`;
		if (!(await ctx.ui.confirm("Global pi-lens config", message))) {
			ctx.ui.notify("mule-lsp: init --global cancelled.", "info");
			return undefined;
		}
	}
	return { configPath: resolution.path, mode: "global" };
}

/** Moves legacy files, writes the shim, returns notes to show. */
function prepareInstall(services: CommandServices): string[] {
	const notes: string[] = [];
	const moved = migrateLegacy(services, services.now);
	if (moved.length > 0) notes.push(`Moved legacy toolkit (${moved.join(", ")}) to ${dataDir(services)}/legacy-toolkit-*.`);
	const shim = ensureShim(services, { node: services.node, version: packageVersion(services.fs) });
	notes.push(shim.status === "written" ? `Wrote launcher ${shim.path}.` : `Launcher ${shim.path} already up to date.`);
	return notes;
}

function assertDataDirUsable(services: CommandServices): void {
	const dir = dataDir(services);
	if (hasWhitespace(dir)) throw new Error(`data dir '${dir}' contains whitespace, which the catalog does not support. Set MULE_LSP_DATA_DIR to another path.`);
}

async function handleInit(tokens: string[], ctx: ExtensionCommandContext, services: CommandServices): Promise<void> {
	assertDataDirUsable(services);
	const args = parseInitArgs(tokens);
	const target = await resolveTarget(args, ctx, services);
	if (!target) return;
	const notes = prepareInstall(services);
	if (!services.fs.existsSync(catalogPath(services))) {
		ctx.ui.notify("mule-lsp: catalog missing, generating (this can take a minute)…", "info");
		const catalog = await runCatalog(services.runner, services);
		if (!catalog.ok) return ctx.ui.notify(`mule-lsp: catalog generation failed:\n${catalog.stderr.trim()}`, "error");
	}
	const check = await runCheck(services.runner, services, shimPath(services));
	if (!check.ok) {
		return ctx.ui.notify(`mule-lsp: environment check failed, config not written:\n${check.missing.join("\n") || check.stderr.trim()}`, "error");
	}
	const entry = buildEntry({ mode: target.mode, command: shimPath(services), catalog: catalogPath(services) });
	const result = applyServerEntry(target.configPath, entry, services);
	const level = result.status === "refused" ? "error" : "info";
	const steps = result.status === "refused" ? "" : `\n${nextSteps(target.mode === "global")}`;
	ctx.ui.notify(`mule-lsp: ${[...notes, describeResult(result)].join("\n")}${steps}`, level);
}

async function handleCatalog(ctx: ExtensionCommandContext, services: CommandServices): Promise<void> {
	assertDataDirUsable(services);
	const notes = prepareInstall(services);
	ctx.ui.notify("mule-lsp: generating catalog from Anypoint Studio…", "info");
	const result = await runCatalog(services.runner, services);
	if (!result.ok) return ctx.ui.notify(`mule-lsp: catalog generation failed:\n${result.stderr.trim()}`, "error");
	const warnings = result.warnings.length > 0 ? `\n${result.warnings.length} warning(s):\n${result.warnings.map((w) => `  - ${w}`).join("\n")}` : "";
	const summary = `core ${result.core}, connectors ${result.connectors}, entries ${result.entries} -> ${result.out}`;
	ctx.ui.notify(`mule-lsp: ${[...notes, `Catalog ready: ${summary}.`].join("\n")}${warnings}\nRun /reload so the language server re-reads it.`, result.warnings.length > 0 ? "warning" : "info");
}

function toDoctorContext(pi: ExtensionAPI, ctx: ExtensionCommandContext): DoctorContext {
	const packages = pi.getSettings().packages ?? [];
	return {
		cwd: ctx.cwd,
		isProjectTrusted: ctx.isProjectTrusted(),
		toolNames: pi.getAllTools().map((tool) => tool.name),
		settingsPackages: packages.map((entry) => (typeof entry === "string" ? entry : entry.source)),
	};
}

async function handleDoctor(pi: ExtensionAPI, ctx: ExtensionCommandContext, services: CommandServices): Promise<void> {
	const items = await collectChecks(toDoctorContext(pi, ctx), services);
	ctx.ui.notify(formatReport(items), LEVELS[worstStatus(items)]);
}

export function registerCommands(pi: ExtensionAPI, getServices: () => CommandServices = defaultServices): void {
	pi.registerCommand("mule-lsp", {
		description: "MuleSoft XML diagnostics for pi-lens: init | catalog | doctor",
		getArgumentCompletions: getCompletions,
		handler: async (args, ctx) => {
			const [subcommand = "help", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			try {
				const services = getServices();
				if (subcommand === "init") return await handleInit(rest, ctx, services);
				if (subcommand === "catalog") return await handleCatalog(ctx, services);
				if (subcommand === "doctor") return await handleDoctor(pi, ctx, services);
				ctx.ui.notify(HELP, subcommand === "help" ? "info" : "warning");
			} catch (error) {
				ctx.ui.notify(`mule-lsp: ${(error as Error).message}`, "error");
			}
		},
	});
}
