let buffer = Buffer.alloc(0);

function send(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
  process.stdout.write(
    Buffer.concat([
      Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),
      body,
    ]),
  );
}

function handle(message) {
  if (message.method === "initialize") {
    send({ id: message.id, result: { capabilities: {} } });
  } else if (message.method === "textDocument/didOpen") {
    send({
      method: "textDocument/publishDiagnostics",
      params: {
        uri: message.params.textDocument.uri,
        diagnostics: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 4 },
            },
            severity: 1,
            source: "fake-lsp",
            message: "Synthetic diagnostic",
          },
        ],
      },
    });
  } else if (message.method === "shutdown") {
    send({ id: message.id, result: null });
  } else if (message.method === "exit") {
    process.exit(0);
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString("ascii");
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) process.exit(2);
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) return;
    const message = JSON.parse(
      buffer.subarray(bodyStart, bodyStart + length).toString("utf8"),
    );
    buffer = buffer.subarray(bodyStart + length);
    handle(message);
  }
});
