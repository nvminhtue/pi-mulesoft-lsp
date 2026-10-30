import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { makeTmp, writeFile } from "./helpers/deps.mjs";

const WRAPPER = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "mule-xml-lsp");
// MULE_LSP_JAVA_HOME=/nonexistent proves the gate runs before any Java lookup (no Studio needed in CI).
const gateEnv = { PATH: process.env.PATH, HOME: tmpdir(), MULE_LSP_REQUIRE_MARKER: "1", MULE_LSP_JAVA_HOME: "/nonexistent", MULE_LSP_NODE: process.execPath };

function frame(message) {
	const body = JSON.stringify({ jsonrpc: "2.0", ...message });
	return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

function parseFrames(buffer) {
	const messages = [];
	let rest = buffer;
	for (;;) {
		const headerEnd = rest.indexOf("\r\n\r\n");
		if (headerEnd < 0) return messages;
		const length = Number(/Content-Length: (\d+)/.exec(rest.slice(0, headerEnd))[1]);
		messages.push(JSON.parse(rest.slice(headerEnd + 4, headerEnd + 4 + length)));
		rest = rest.slice(headerEnd + 4 + length);
	}
}

function handshake(cwd) {
	return new Promise((resolve, reject) => {
		const child = spawn("bash", [WRAPPER], { cwd, env: gateEnv, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`timeout; stdout=${stdout}`)); }, 5000);
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.on("exit", (code) => { clearTimeout(timer); resolve({ code, messages: parseFrames(stdout), stdout }); });
		const uri = "file:///x/pom.xml";
		child.stdin.write(frame({ id: 1, method: "initialize", params: { rootUri: null, capabilities: {} } }));
		child.stdin.write(frame({ method: "initialized", params: {} }));
		child.stdin.write(frame({ method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "xml", version: 1, text: "<a/>" } } }));
		child.stdin.write(frame({ id: 2, method: "textDocument/hover", params: {} }));
		child.stdin.write(frame({ id: 3, method: "shutdown", params: null }));
		child.stdin.write(frame({ method: "exit" }));
	});
}

test("global mode in a directory without mule-artifact.json serves a no-op LSP, no JVM", async () => {
	const started = Date.now();
	const { code, messages } = await handshake(makeTmp("plain-"));
	assert.equal(code, 0);
	assert.deepEqual(messages.find((m) => m.id === 1).result, { capabilities: { textDocumentSync: 1 } });
	const published = messages.find((m) => m.method === "textDocument/publishDiagnostics");
	assert.deepEqual(published.params, { uri: "file:///x/pom.xml", diagnostics: [] });
	assert.equal(messages.find((m) => m.id === 2).result, null);
	assert.equal(messages.find((m) => m.id === 3).result, null);
	assert.ok(Date.now() - started < 2000, "handshake is fast");
});

test("the gate also opens for a marker two levels below the working directory", () => {
	const cwd = makeTmp("nested-");
	writeFile(join(cwd, "a/b/mule-artifact.json"), "{}");
	const result = spawnSync("bash", [WRAPPER], { cwd, env: gateEnv, encoding: "utf8", input: "" });
	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /no usable Java 17/);
});

test("with a marker in cwd the real server path is taken: fails fast without Java, stdout stays empty", () => {
	const cwd = makeTmp("mule-");
	writeFile(join(cwd, "mule-artifact.json"), "{}");
	const result = spawnSync("bash", [WRAPPER], { cwd, env: gateEnv, encoding: "utf8", input: "" });
	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
});

test("--check reports every missing item as key=value lines on stderr and exits 1", () => {
	const env = { PATH: process.env.PATH, HOME: tmpdir(), MULE_LSP_STUDIO: "/nonexistent-studio", MULE_LSP_VSCODE_EXT: "/nonexistent-ext", MULE_LSP_JAVA_HOME: "/nonexistent" };
	const result = spawnSync("bash", [WRAPPER, "--check"], { cwd: makeTmp(), env, encoding: "utf8" });
	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	const missing = result.stderr.split("\n").filter((line) => line.startsWith("missing=")).map((line) => line.slice(8).split(":")[0]);
	assert.deepEqual(missing.sort(), ["dev_jar", "java_home", "jar.failureaccess", "jar.gson", "jar.guava", "jar.lsp4j", "jar.lsp4j.jsonrpc", "studio"].sort());
});

test("--check ignores the global-mode gate and succeeds against a fake Studio layout", () => {
	const studio = makeTmp("studio-");
	const plugins = join(studio, "Contents/Eclipse/plugins");
	const ext = makeTmp("ext-");
	const java = makeTmp("java-");
	writeFile(join(java, "bin/java"), "#!/bin/sh\n");
	spawnSync("chmod", ["+x", join(java, "bin/java")]);
	for (const jar of ["org.eclipse.lsp4j_1.jar", "org.eclipse.lsp4j.jsonrpc_1.jar", "com.google.gson_1.jar", "com.google.guava_1.jar", "com.google.guava.failureaccess_1.jar"]) {
		writeFile(join(plugins, jar), "x");
	}
	writeFile(join(ext, "salesforce.mule-dx-mule-dev-component-1/libs/mule-dx-mule-dev-plugin-1-all.jar"), "x");
	const env = { ...gateEnv, MULE_LSP_STUDIO: studio, MULE_LSP_VSCODE_EXT: ext, MULE_LSP_JAVA_HOME: java };
	const result = spawnSync("bash", [WRAPPER, "--check"], { cwd: makeTmp("plain-"), env, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, new RegExp(`java_home=${java}`));
	assert.match(result.stderr, /jar\.gson=.*com\.google\.gson_1\.jar/);
	assert.doesNotMatch(result.stderr, /missing=/);
});
