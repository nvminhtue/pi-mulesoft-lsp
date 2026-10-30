#!/usr/bin/env node
// No-op LSP server used by mule-xml-lsp in global mode when the workspace is not a Mule project.
// Answers the handshake, publishes empty diagnostics so pi-lens never waits for a timeout, never prints to stdout
// except LSP frames.
let buffer = Buffer.alloc(0);
let isShutdown = false;

function send(message) {
	const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8");
	process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
	process.stdout.write(body);
}

function publishEmpty(uri) {
	send({ method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [] } });
}

function handleNotification(method, params) {
	if (method === "exit") process.exit(isShutdown ? 0 : 1);
	const isDocumentEvent = method === "textDocument/didOpen" || method === "textDocument/didChange" || method === "textDocument/didSave";
	const uri = params?.textDocument?.uri;
	if (isDocumentEvent && uri) publishEmpty(uri);
}

function handleRequest(id, method) {
	if (method === "initialize") {
		return send({ id, result: { capabilities: { textDocumentSync: 1 } } });
	}
	if (method === "shutdown") isShutdown = true;
	send({ id, result: null });
}

function handleMessage(message) {
	const hasId = message.id !== undefined && message.id !== null;
	if (hasId && message.method) return handleRequest(message.id, message.method);
	if (!hasId && message.method) handleNotification(message.method, message.params);
}

function drain() {
	for (;;) {
		const headerEnd = buffer.indexOf("\r\n\r\n");
		if (headerEnd < 0) return;
		const match = /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString("ascii"));
		if (!match) {
			buffer = buffer.subarray(headerEnd + 4);
			continue;
		}
		const length = Number(match[1]);
		if (buffer.length < headerEnd + 4 + length) return;
		const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf8");
		buffer = buffer.subarray(headerEnd + 4 + length);
		try {
			handleMessage(JSON.parse(body));
		} catch {
			// Malformed frame: ignore, keep serving.
		}
	}
}

process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	drain();
});
process.stdin.on("end", () => process.exit(0));
