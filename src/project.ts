import { dirname, join, resolve } from "node:path";
import type { Deps } from "./paths.ts";

export const MULE_MARKER = "mule-artifact.json";

/** Nearest ancestor of `start` (inclusive) holding mule-artifact.json; never looks in `$HOME` or above it. */
export function findMuleRoot(start: string, deps: Pick<Deps, "fs" | "home">): string | undefined {
	const home = resolve(deps.home);
	let dir = resolve(start);
	for (;;) {
		if (dir === home) return undefined;
		if (deps.fs.existsSync(join(dir, MULE_MARKER))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}
