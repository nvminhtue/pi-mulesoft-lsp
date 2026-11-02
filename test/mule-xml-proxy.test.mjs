import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createClientTransform, rewriteInitializeFrame } from "../bin/mule-xml-proxy.mjs";

const PROXY = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "mule-xml-proxy.mjs");

const frame = (message) => {
	const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8");
	return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
};

/** Parses concatenated frames, asserting every Content-Length is byte-accurate. */
function parseFrames(buffer) {
	const messages = [];
	let rest = buffer;
	while (rest.length > 0) {
		const headerEnd = rest.indexOf("\r\n\r\n");
		assert.ok(headerEnd >= 0, "incomplete header");
		const length = Number(/Content-Length: (\d+)/.exec(rest.subarray(0, headerEnd).toString("ascii"))[1]);
		const bodyEnd = headerEnd + 4 + length;
		assert.ok(rest.length >= bodyEnd, "incomplete body");
		messages.push(JSON.parse(rest.subarray(headerEnd + 4, bodyEnd).toString("utf8")));
		rest = rest.subarray(bodyEnd);
	}
	return messages;
}

const initialize = (capabilities, extra = {}) => ({ id: 1, method: "initialize", params: { rootUri: null, capabilities, ...extra } });
const watchedTrue = { workspace: { configuration: true, didChangeWatchedFiles: { dynamicRegistration: true } } };

function collect() {
	const frames = [];
	return { frames, push: createClientTransform((f) => frames.push(Buffer.from(f))) };
}

test("initialize: dynamicRegistration true becomes false, everything else is kept", () => {
	const { frames, push } = collect();
	push(frame(initialize(watchedTrue, { initializationOptions: { a: [1, 2] } })));
	const [message] = parseFrames(Buffer.concat(frames));
	assert.equal(message.params.capabilities.workspace.didChangeWatchedFiles.dynamicRegistration, false);
	assert.equal(message.params.capabilities.workspace.configuration, true);
	assert.deepEqual(message.params.initializationOptions, { a: [1, 2] });
	assert.equal(message.id, 1);
});

test("initialize: missing workspace / didChangeWatchedFiles / dynamicRegistration is forwarded byte-for-byte", () => {
	for (const capabilities of [{}, { workspace: {} }, { workspace: { didChangeWatchedFiles: {} } }, { workspace: { didChangeWatchedFiles: { dynamicRegistration: false } } }]) {
		const original = frame(initialize(capabilities));
		const { frames, push } = collect();
		push(original);
		assert.deepEqual(Buffer.concat(frames), original);
	}
});

test("initialize without params.capabilities is untouched", () => {
	const original = frame({ id: 1, method: "initialize", params: {} });
	assert.equal(rewriteInitializeFrame(original.subarray(0, original.indexOf("\r\n\r\n")), original.subarray(original.indexOf("\r\n\r\n") + 4)), undefined);
});

test("non-initialize messages are forwarded byte-for-byte, even when they mention the flag", () => {
	const messages = [
		{ method: "initialized", params: {} },
		{ method: "textDocument/didOpen", params: { textDocument: { uri: "file:///a.xml", text: JSON.stringify(initialize(watchedTrue)) } } },
		{ id: 2, method: "workspace/executeCommand", params: { capabilities: watchedTrue } },
		{ id: 3, result: { capabilities: watchedTrue } },
	];
	const original = Buffer.concat(messages.map(frame));
	const { frames, push } = collect();
	push(original);
	assert.equal(frames.length, messages.length);
	assert.deepEqual(Buffer.concat(frames), original);
});

test("multiple frames in one chunk are all emitted, only initialize rewritten", () => {
	const { frames, push } = collect();
	push(Buffer.concat([frame(initialize(watchedTrue)), frame({ method: "initialized", params: {} }), frame({ method: "textDocument/didOpen", params: { x: 1 } })]));
	const messages = parseFrames(Buffer.concat(frames));
	assert.deepEqual(messages.map((m) => m.method), ["initialize", "initialized", "textDocument/didOpen"]);
	assert.equal(messages[0].params.capabilities.workspace.didChangeWatchedFiles.dynamicRegistration, false);
});

test("frames split at arbitrary byte boundaries (one byte at a time) are reassembled", () => {
	const input = Buffer.concat([frame({ method: "initialized", params: {} }), frame(initialize(watchedTrue)), frame({ method: "exit" })]);
	const { frames, push } = collect();
	for (const byte of input) push(Buffer.from([byte]));
	const messages = parseFrames(Buffer.concat(frames));
	assert.deepEqual(messages.map((m) => m.method), ["initialized", "initialize", "exit"]);
	assert.equal(messages[1].params.capabilities.workspace.didChangeWatchedFiles.dynamicRegistration, false);
});

test("a partial frame emits nothing until it completes", () => {
	const whole = frame(initialize(watchedTrue));
	const { frames, push } = collect();
	push(whole.subarray(0, whole.length - 3));
	assert.equal(frames.length, 0);
	push(whole.subarray(whole.length - 3));
	assert.equal(frames.length, 1);
});

test("unicode bodies: Content-Length counts bytes, not characters, before and after rewrite", () => {
	const text = "<flow name=\"héllo-日本語-😀\"/>";
	const open = frame({ method: "textDocument/didOpen", params: { textDocument: { text } } });
	const init = frame(initialize(watchedTrue, { initializationOptions: { name: "日本語-😀-é" } }));
	const input = Buffer.concat([open, init]);
	const { frames, push } = collect();
	// Split in the middle of a multi-byte character of the first body.
	const cut = input.indexOf(Buffer.from("日")) + 1;
	push(input.subarray(0, cut));
	push(input.subarray(cut));
	const messages = parseFrames(Buffer.concat(frames));
	assert.equal(messages[0].params.textDocument.text, text);
	assert.equal(messages[1].params.initializationOptions.name, "日本語-😀-é");
	assert.equal(messages[1].params.capabilities.workspace.didChangeWatchedFiles.dynamicRegistration, false);
	assert.deepEqual(frames[0], open);
});

test("extra headers (Content-Type) survive the rewrite", () => {
	const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...initialize(watchedTrue) }), "utf8");
	const input = Buffer.concat([Buffer.from(`Content-Type: application/vscode-jsonrpc; charset=utf-8\r\nContent-Length: ${body.length}\r\n\r\n`), body]);
	const { frames, push } = collect();
	push(input);
	const out = Buffer.concat(frames);
	assert.match(out.toString("utf8"), /^Content-Type: application\/vscode-jsonrpc; charset=utf-8\r\nContent-Length: \d+\r\n\r\n/);
	assert.equal(parseFrames(out.subarray(out.indexOf("Content-Length")))[0].params.capabilities.workspace.didChangeWatchedFiles.dynamicRegistration, false);
});

test("a header block without Content-Length switches to raw passthrough for the rest of the stream", () => {
	const { frames, push } = collect();
	const garbage = Buffer.from("X-Foo: bar\r\n\r\nrandom-bytes");
	const later = frame(initialize(watchedTrue));
	push(Buffer.concat([frame({ method: "initialized", params: {} }), garbage]));
	push(later);
	push(Buffer.from("tail"));
	const expected = Buffer.concat([frame({ method: "initialized", params: {} }), garbage, later, Buffer.from("tail")]);
	assert.deepEqual(Buffer.concat(frames), expected);
});

// --- process-level behaviour, with a tiny fake server that echoes what it receives ---
const ECHO_SERVER = `
process.stdin.on("data", (d) => { process.stdout.write(d); });
process.stdin.on("end", () => process.exit(Number(process.env.FAKE_EXIT ?? 0)));
`;

function runProxy(input, env = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [PROXY, "--", process.execPath, "-e", ECHO_SERVER], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
		const chunks = [];
		const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("timeout")); }, 10000);
		child.stdout.on("data", (d) => chunks.push(d));
		child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(chunks) }); });
		child.stdin.end(input);
	});
}

test("process: rewrites initialize on the way in, pipes server output back, ends child on stdin end", async () => {
	const { code, stdout } = await runProxy(Buffer.concat([frame(initialize(watchedTrue)), frame({ method: "initialized", params: {} })]));
	assert.equal(code, 0);
	const messages = parseFrames(stdout);
	assert.equal(messages[0].params.capabilities.workspace.didChangeWatchedFiles.dynamicRegistration, false);
	assert.equal(messages[1].method, "initialized");
});

test("process: propagates the server's exit code", async () => {
	const { code } = await runProxy(frame({ method: "exit" }), { FAKE_EXIT: "3" });
	assert.equal(code, 3);
});

test("process: SIGTERM to the proxy kills the server child", async () => {
	const server = 'process.stdout.write(String(process.pid) + "\\n"); setInterval(() => {}, 1000);';
	const child = spawn(process.execPath, [PROXY, "--", process.execPath, "-e", server], { stdio: ["pipe", "pipe", "pipe"] });
	const serverPid = await new Promise((resolve) => child.stdout.once("data", (d) => resolve(Number(String(d).trim()))));
	const closed = new Promise((resolve) => child.on("close", (code) => resolve(code)));
	child.kill("SIGTERM");
	await closed;
	assert.throws(() => process.kill(serverPid, 0), { code: "ESRCH" });
});

test("process: missing server command exits 127 with a stderr message", async () => {
	const child = spawn(process.execPath, [PROXY, "--", "/nonexistent/server-binary"], { stdio: ["pipe", "pipe", "pipe"] });
	let stderr = "";
	child.stderr.on("data", (d) => { stderr += d; });
	const code = await new Promise((resolve) => child.on("close", resolve));
	assert.equal(code, 127);
	assert.match(stderr, /cannot start/);
});

test("process: client closing the proxy's stdout (EPIPE) stops the server child", async () => {
	// The fake server ignores EPIPE on its own stdout, like a JVM would, so only the proxy can stop it.
	const server = 'process.stdout.on("error", () => {}); process.stdout.write(String(process.pid) + "\\n"); setInterval(() => process.stdout.write("x".repeat(1024)), 20);';
	const child = spawn(process.execPath, [PROXY, "--", process.execPath, "-e", server], { stdio: ["pipe", "pipe", "ignore"] });
	const serverPid = await new Promise((resolve) => child.stdout.once("data", (d) => resolve(Number(String(d).split("\n")[0]))));
	const closed = new Promise((resolve) => child.on("close", resolve));
	child.stdout.destroy();
	const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
	await closed;
	clearTimeout(timer);
	const isAlive = () => { try { process.kill(serverPid, 0); return true; } catch { return false; } };
	const deadline = Date.now() + 5000;
	while (isAlive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(isAlive(), false, "fake server must be gone after the client closed stdout");
});
