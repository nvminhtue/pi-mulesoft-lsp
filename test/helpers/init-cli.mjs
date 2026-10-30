// Local-test helper (not shipped): register the repo's own bin/mule-xml-lsp, bypassing the user's launcher shim.
// Usage: node --experimental-strip-types test/helpers/init-cli.mjs <project-dir>
//        node --experimental-strip-types test/helpers/init-cli.mjs --global <config-file>
// The catalog location follows MULE_LSP_DATA_DIR (default: the agent data dir).
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyServerEntry, buildEntry, PROJECT_CONFIG_FILE } from "../../src/lens-config.ts";
import { catalogPath, defaultDeps } from "../../src/paths.ts";

const deps = defaultDeps();
const command = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "mule-xml-lsp");
const [first, second] = process.argv.slice(2);
const isGlobal = first === "--global";
const target = isGlobal ? second : first;
if (!target) {
	console.error("usage: init-cli.mjs <project-dir> | --global <config-file>");
	process.exit(2);
}
const configPath = isGlobal ? resolve(target) : join(resolve(target), PROJECT_CONFIG_FILE);
const entry = buildEntry({ mode: isGlobal ? "global" : "project", command, catalog: catalogPath(deps) });
const result = applyServerEntry(configPath, entry, deps);
console.log(`${result.status}: ${configPath}`);
process.exit(result.status === "refused" ? 1 : 0);
