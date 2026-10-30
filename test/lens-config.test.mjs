import assert from "node:assert/strict";
import * as realFs from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
	applyServerEntry,
	buildEntry,
	findMuleServer,
	findProjectLensConfigs,
	mergeServerEntry,
	resolveGlobalLensConfig,
} from "../src/lens-config.ts";
import { makeDeps, makeTmp, readJson, writeFile } from "./helpers/deps.mjs";

const entryFor = (deps, mode = "project") =>
	buildEntry({ mode, command: join(deps.home, ".pi/agent/mulesoft-lsp/bin/mule-xml-lsp"), catalog: join(deps.home, ".pi/agent/mulesoft-lsp/xsd/catalog.xml") });

// ---- global config location (port of pi-lens resolveGlobalConfigLocation)

test("global path: PI_LENS_CONFIG_PATH wins and is resolved", () => {
	const deps = makeDeps({ env: { PI_LENS_CONFIG_PATH: "rel/cfg.json" } });
	writeFile(join(deps.home, ".pi-lens/config.json"), "{}");
	const resolution = resolveGlobalLensConfig(deps);
	assert.equal(resolution.path, resolve("rel/cfg.json"));
	assert.equal(resolution.source, "pi-lens-config-path");
});

test("global path: empty PI_LENS_CONFIG_PATH is ignored", () => {
	const deps = makeDeps({ env: { PI_LENS_CONFIG_PATH: "" } });
	assert.equal(resolveGlobalLensConfig(deps).source, "canonical-default");
});

test("global path: existing ~/.pi-lens/config.json beats the agent-dir file", () => {
	const agent = makeTmp("agent-");
	const deps = makeDeps({ env: { PI_CODING_AGENT_DIR: agent } });
	writeFile(join(deps.home, ".pi-lens/config.json"), "{}");
	writeFile(join(agent, "extensions/pi-lens.json"), "{}");
	const resolution = resolveGlobalLensConfig(deps);
	assert.equal(resolution.source, "legacy-default-existing");
	assert.equal(resolution.path, join(deps.home, ".pi-lens/config.json"));
});

test("global path: agent-dir file is used only when it exists", () => {
	const agent = makeTmp("agent-");
	const deps = makeDeps({ env: { PI_CODING_AGENT_DIR: agent } });
	assert.equal(resolveGlobalLensConfig(deps).source, "canonical-default");
	writeFile(join(agent, "extensions/pi-lens.json"), "{}");
	const resolution = resolveGlobalLensConfig(deps);
	assert.equal(resolution.source, "pi-coding-agent-dir");
	assert.equal(resolution.path, join(agent, "extensions/pi-lens.json"));
});

test("global path: nothing exists and no agent dir -> canonical default", () => {
	const deps = makeDeps();
	const resolution = resolveGlobalLensConfig(deps);
	assert.deepEqual(resolution, { path: join(deps.home, ".pi-lens/config.json"), source: "canonical-default" });
});

test("global path: non-ENOENT probe errors keep their tier (fail closed)", () => {
	const throwing = (code, only) => ({
		...realFs,
		statSync: (path, ...rest) => {
			if (path.includes(only)) throw Object.assign(new Error(code), { code });
			return realFs.statSync(path, ...rest);
		},
	});
	const agent = makeTmp("agent-");
	const legacyFail = makeDeps({ fs: throwing("EACCES", ".pi-lens"), env: { PI_CODING_AGENT_DIR: agent } });
	assert.equal(resolveGlobalLensConfig(legacyFail).source, "legacy-default-unprobed");
	assert.match(resolveGlobalLensConfig(legacyFail).probeError, /EACCES/);
	const agentFail = makeDeps({ fs: throwing("ENOTDIR", "pi-lens.json"), env: { PI_CODING_AGENT_DIR: agent } });
	assert.equal(resolveGlobalLensConfig(agentFail).source, "pi-coding-agent-dir-unprobed");
});

// ---- entry shape

test("project entry is byte-identical to the legacy toolkit's entry", () => {
	const deps = makeDeps();
	const data = join(deps.home, ".pi/agent/mulesoft-lsp");
	const legacy = `{
  "lsp": {
    "servers": {
      "mule-xml": {
        "name": "MuleSoft XML (LemMinX)",
        "extensions": [
          ".xml"
        ],
        "command": "${data}/bin/mule-xml-lsp",
        "args": [],
        "rootMarkers": [
          "mule-artifact.json"
        ],
        "initializationOptions": {
          "settings": {
            "xml": {
              "catalogs": [
                "${data}/xsd/catalog.xml"
              ]
            }
          },
          "xml": {
            "catalogs": [
              "${data}/xsd/catalog.xml"
            ]
          }
        }
      }
    }
  }
}
`;
	const merged = mergeServerEntry(undefined, entryFor(deps));
	assert.equal(merged.ok && merged.output, legacy);
	const again = mergeServerEntry(legacy, entryFor(deps));
	assert.equal(again.ok && again.changed, false);
});

test("global entry adds env MULE_LSP_REQUIRE_MARKER after the legacy keys", () => {
	const entry = entryFor(makeDeps(), "global");
	assert.deepEqual(entry.env, { MULE_LSP_REQUIRE_MARKER: "1" });
	assert.equal(Object.keys(entry).at(-1), "env");
	assert.equal(entryFor(makeDeps(), "project").env, undefined);
});

// ---- merge rules

test("merge keeps unrelated keys and other servers", () => {
	const deps = makeDeps();
	const text = JSON.stringify({ ignore: ["target/**"], lsp: { disabledServers: ["typos"], servers: { other: { command: "x" } } } });
	const merged = mergeServerEntry(text, entryFor(deps));
	assert.ok(merged.ok);
	const config = JSON.parse(merged.output);
	assert.deepEqual(config.ignore, ["target/**"]);
	assert.deepEqual(config.lsp.disabledServers, ["typos"]);
	assert.deepEqual(Object.keys(config.lsp.servers).sort(), ["mule-xml", "other"]);
	assert.ok(merged.output.endsWith("\n"));
});

test("merge refuses non-object configs and JSONC, returning the entry for manual merge", () => {
	const entry = entryFor(makeDeps());
	for (const bad of ["null", "[]", '{"lsp":true}', '{"lsp":{"servers":[]}}', '{\n // c\n "a": 1\n}']) {
		const merged = mergeServerEntry(bad, entry);
		assert.equal(merged.ok, false, bad);
		assert.match(merged.reason, /Not modified/);
		assert.deepEqual(JSON.parse(merged.manual), JSON.parse(JSON.stringify(entry)));
	}
});

// ---- apply (write + .bak)

test("apply: creates the file, is idempotent, no .bak for new or unchanged files", () => {
	const deps = makeDeps();
	const path = join(makeTmp(), "nested/.pi-lens.json");
	const entry = entryFor(deps);
	assert.equal(applyServerEntry(path, entry, deps).status, "written");
	assert.equal(applyServerEntry(path, entry, deps).status, "unchanged");
	assert.equal(realFs.existsSync(`${path}.bak`), false);
	assert.deepEqual(readJson(path).lsp.servers["mule-xml"].command, entry.command);
});

test(".bak holds the original, only when content changes, and is never overwritten", () => {
	const deps = makeDeps();
	const path = join(makeTmp(), ".pi-lens.json");
	writeFile(path, '{"lsp":{"disabledServers":["typos"]}}');
	const first = applyServerEntry(path, entryFor(deps), deps);
	assert.equal(first.status === "written" && first.backedUp, true);
	applyServerEntry(path, entryFor(deps), deps);
	const changed = buildEntry({ mode: "global", command: "/other", catalog: "/c.xml" });
	applyServerEntry(path, changed, deps);
	const backup = realFs.readFileSync(`${path}.bak`, "utf8");
	assert.match(backup, /typos/);
	assert.doesNotMatch(backup, /mule-xml/);
});

test("apply: refused configs are left byte-for-byte untouched", () => {
	const deps = makeDeps();
	const path = join(makeTmp(), ".pi-lens.json");
	writeFile(path, "[]");
	const result = applyServerEntry(path, entryFor(deps), deps);
	assert.equal(result.status, "refused");
	assert.equal(realFs.readFileSync(path, "utf8"), "[]");
	assert.equal(realFs.existsSync(`${path}.bak`), false);
});

// ---- discovery

test("findProjectLensConfigs walks up, nearest first, and stops before HOME", () => {
	const deps = makeDeps();
	writeFile(join(deps.home, ".pi-lens.json"), "{}");
	writeFile(join(deps.home, "a/.pi-lens.json"), "{}");
	writeFile(join(deps.home, "a/b/.pi-lens.json"), "{}");
	const found = findProjectLensConfigs(join(deps.home, "a/b/c"), deps);
	assert.deepEqual(found, [join(deps.home, "a/b/.pi-lens.json"), join(deps.home, "a/.pi-lens.json")]);
});

test("findMuleServer finds project and global registrations and skips broken files", () => {
	const deps = makeDeps({ env: { PI_LENS_CONFIG_PATH: join(makeTmp(), "global.json") } });
	const project = join(deps.home, "proj");
	writeFile(join(project, ".pi-lens.json"), "{ not json");
	assert.deepEqual(findMuleServer(project, deps), {});
	applyServerEntry(join(project, ".pi-lens.json"), entryFor(deps), { fs: realFs });
	assert.equal(findMuleServer(project, deps).project, undefined);
	writeFile(join(project, ".pi-lens.json"), "{}");
	applyServerEntry(join(project, ".pi-lens.json"), entryFor(deps), deps);
	applyServerEntry(deps.env.PI_LENS_CONFIG_PATH, entryFor(deps, "global"), deps);
	const found = findMuleServer(project, deps);
	assert.equal(found.project.path, join(project, ".pi-lens.json"));
	assert.equal(found.global.path, deps.env.PI_LENS_CONFIG_PATH);
});

test("apply: a symlinked config stays a symlink; the real target is updated and backed up beside it", () => {
	const deps = makeDeps();
	const dir = makeTmp();
	const target = join(dir, "dotfiles/pi-lens.json");
	const link = join(dir, "config.json");
	writeFile(target, '{"lsp":{"disabledServers":["typos"]}}');
	realFs.symlinkSync(target, link);
	const result = applyServerEntry(link, entryFor(deps), deps);
	assert.equal(result.status, "written");
	assert.equal(realFs.lstatSync(link).isSymbolicLink(), true);
	assert.equal(realFs.realpathSync(link), target);
	const config = readJson(target);
	assert.deepEqual(config.lsp.disabledServers, ["typos"]);
	assert.ok(config.lsp.servers["mule-xml"]);
	assert.match(realFs.readFileSync(`${target}.bak`, "utf8"), /typos/);
	assert.equal(realFs.existsSync(`${link}.bak`), false);
	assert.deepEqual(realFs.readdirSync(join(dir, "dotfiles")).sort(), ["pi-lens.json", "pi-lens.json.bak"]);
});
