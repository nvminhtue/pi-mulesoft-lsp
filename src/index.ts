/** pi-mulesoft-lsp — MuleSoft XML diagnostics in pi-lens (/mule-lsp init|catalog|doctor). */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defaultServices, registerCommands } from "./commands.ts";
import type { CommandServices } from "./commands.ts";
import { ensureShim, inspectShim } from "./install.ts";
import { findMuleServer } from "./lens-config.ts";
import { packageVersion } from "./paths.ts";
import { findMuleRoot } from "./project.ts";

export interface Hint {
	message: string;
	level: "info" | "warning";
}

/** Pure decision: what (if anything) to tell the user about a Mule project. May repair a broken shim. */
export function computeHint(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">, services: CommandServices): Hint | undefined {
	if (!findMuleRoot(ctx.cwd, services)) return undefined;
	const found = findMuleServer(ctx.cwd, services);
	if (!found.project && !found.global) {
		return { level: "info", message: "Mule project detected — run `/mule-lsp init` (or `/mule-lsp init --global`) to enable XML diagnostics." };
	}
	if (found.project && !found.global && !ctx.isProjectTrusted()) {
		return { level: "warning", message: "Mule XML server is configured for this project but the project is not trusted — run /trust, then /reload." };
	}
	return shimHint(services);
}

function shimHint(services: CommandServices): Hint | undefined {
	const shim = inspectShim(services);
	if (!shim.exists) return { level: "warning", message: "Mule launcher shim is missing — run /mule-lsp init." };
	if (!shim.isGenerated) return undefined;
	if (!shim.isTargetValid) {
		try {
			ensureShim(services, { node: services.node, version: packageVersion(services.fs) });
			return undefined;
		} catch {
			return { level: "warning", message: "Mule launcher shim points to a missing package — run /mule-lsp init." };
		}
	}
	if (!shim.isCurrentPackage) {
		return { level: "info", message: `Mule launcher shim points to another pi-mulesoft-lsp install (${shim.target}); run /mule-lsp init to switch it to this one.` };
	}
	return undefined;
}

export function createExtension(pi: ExtensionAPI, getServices: () => CommandServices = defaultServices): void {
	registerCommands(pi, getServices);
	let hasHinted = false;
	pi.on("session_start", (_event, ctx) => {
		if (hasHinted) return;
		try {
			const hint = computeHint(ctx, getServices());
			if (!hint) return;
			hasHinted = true;
			ctx.ui.notify(`mule-lsp: ${hint.message}`, hint.level);
		} catch {
			// A hint must never break session start.
		}
	});
}

export default function (pi: ExtensionAPI): void {
	createExtension(pi);
}
