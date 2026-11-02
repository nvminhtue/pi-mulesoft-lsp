#!/usr/bin/env node
// Stdio proxy between pi-lens and the real LemMinX server (spawned from argv).
// Why: pi-lens advertises workspace.didChangeWatchedFiles.dynamicRegistration=true; with that flag LemMinX goes
// silent after `initialize` and never publishes diagnostics. This proxy rewrites that one flag to false in the
// `initialize` request and forwards every other byte unchanged. Server -> client is a raw pipe.
// Usage: node mule-xml-proxy.mjs [--] <server-command> [args...]
// stdout is the LSP channel: this script NEVER prints to stdout itself (errors go to stderr).
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { pathToFileURL } from "node:url";

const HEADER_END = Buffer.from("\r\n\r\n");
const CONTENT_LENGTH = /Content-Length:\s*(\d+)/i;
const KILL_GRACE_MS = 2000;
const STDIN_END_GRACE_MS = 5000;

/** Rebuilt frame (header+body bytes) with initialize's didChangeWatchedFiles.dynamicRegistration forced to false, or undefined if nothing needs changing. */
export function rewriteInitializeFrame(header, body) {
	if (!body.includes('"initialize"')) return undefined;
	let message;
	try {
		message = JSON.parse(body.toString("utf8"));
	} catch {
		return undefined;
	}
	const watched = message?.method === "initialize" ? message.params?.capabilities?.workspace?.didChangeWatchedFiles : undefined;
	if (!watched || typeof watched !== "object" || watched.dynamicRegistration === undefined || watched.dynamicRegistration === false) return undefined;
	watched.dynamicRegistration = false;
	const newBody = Buffer.from(JSON.stringify(message), "utf8");
	const newHeader = header.toString("latin1").replace(CONTENT_LENGTH, `Content-Length: ${newBody.length}`);
	return Buffer.concat([Buffer.from(newHeader, "latin1"), HEADER_END, newBody]);
}

/**
 * Accumulates client bytes and emits every complete frame (possibly rewritten) via `emit`; partial frames wait.
 * If a header block has no Content-Length the stream is not LSP framing we understand: everything buffered and
 * all later chunks are forwarded untouched (raw passthrough) because frame boundaries can no longer be known.
 */
export function createClientTransform(emit) {
	let buffer = Buffer.alloc(0);
	let isPassthrough = false;
	return (chunk) => {
		if (isPassthrough) return emit(chunk);
		buffer = Buffer.concat([buffer, chunk]);
		for (;;) {
			const headerEnd = buffer.indexOf(HEADER_END);
			if (headerEnd < 0) return;
			const header = buffer.subarray(0, headerEnd);
			const match = CONTENT_LENGTH.exec(header.toString("latin1"));
			if (!match) {
				isPassthrough = true;
				const rest = buffer;
				buffer = Buffer.alloc(0);
				return emit(rest);
			}
			const frameEnd = headerEnd + HEADER_END.length + Number(match[1]);
			if (buffer.length < frameEnd) return;
			const body = buffer.subarray(headerEnd + HEADER_END.length, frameEnd);
			emit(rewriteInitializeFrame(header, body) ?? buffer.subarray(0, frameEnd));
			buffer = buffer.subarray(frameEnd);
		}
	};
}

function exitCodeFor(code, signal) {
	if (code !== null) return code;
	return 128 + (osConstants.signals[signal] ?? 1);
}

function run(argv) {
	const command = argv[0] === "--" ? argv.slice(1) : argv;
	if (command.length === 0) {
		console.error("mule-xml-proxy: usage: mule-xml-proxy.mjs [--] <server-command> [args...]");
		process.exit(2);
	}
	const child = spawn(command[0], command.slice(1), { stdio: ["pipe", "pipe", "inherit"] });
	child.on("error", (error) => {
		console.error(`mule-xml-proxy: cannot start '${command[0]}': ${error.message}`);
		process.exit(error.code === "ENOENT" ? 127 : 1);
	});
	child.stdin.on("error", () => {});

	let isStopping = false;
	let isFailing = false;
	const stop = (signal) => {
		if (isStopping) return;
		isStopping = true;
		child.kill(signal);
		setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
	};
	// The client went away (EPIPE etc.): stop the JVM, then exit once it is gone.
	const handleClientGone = () => {
		isFailing = true;
		if (child.exitCode !== null || child.signalCode !== null) process.exit(process.exitCode ?? 1);
		stop("SIGTERM");
	};
	const handleCrash = (error) => {
		console.error(`mule-xml-proxy: fatal: ${error instanceof Error ? error.stack : String(error)}`);
		child.kill("SIGKILL");
		process.exit(1);
	};
	process.stdout.on("error", handleClientGone);
	process.stdin.on("error", handleClientGone);
	process.on("uncaughtException", handleCrash);
	process.on("unhandledRejection", handleCrash);
	child.stdout.pipe(process.stdout);

	let isBlocked = false;
	const transform = createClientTransform((frame) => {
		if (!child.stdin.write(frame)) isBlocked = true;
	});
	process.stdin.on("data", (chunk) => {
		transform(chunk);
		if (!isBlocked) return;
		isBlocked = false;
		process.stdin.pause();
		child.stdin.once("drain", () => process.stdin.resume());
	});
	process.stdin.on("end", () => {
		child.stdin.end();
		setTimeout(() => child.kill("SIGTERM"), STDIN_END_GRACE_MS).unref();
	});

	process.on("SIGTERM", () => stop("SIGTERM"));
	process.on("SIGINT", () => stop("SIGTERM"));
	process.on("SIGHUP", () => stop("SIGTERM"));

	child.on("close", (code, signal) => {
		process.exitCode = exitCodeFor(code, signal);
		process.stdin.destroy();
		if (isFailing) process.exit();
	});
}

const isMain = process.argv[1] !== undefined && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
if (isMain) run(process.argv.slice(2));
