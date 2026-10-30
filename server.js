const http = require("http");
const crypto = require("crypto");
const { z } = require("zod");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { config, StepError } = require("./lib/config");
const tools = require("./lib/tools");

const INFO = { name: "unraid_diag", version: "0.2.0" };
const MAX_BODY_BYTES = 1024 * 1024;

// No MCP_TOKEN = everything refused.
function allowed(header) {
  if (!config.mcpToken) {
    return false;
  }

  const hash = (s) => crypto.createHash("sha256").update(String(s)).digest();
  return crypto.timingSafeEqual(hash(`Bearer ${config.mcpToken}`), hash(header || ""));
}

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

function wrap(fn) {
  return async (args) => {
    try {
      return ok(await fn(args || {}));
    } catch (e) {
      if (!(e instanceof StepError)) {
        console.error(e);
      }

      return { content: [{ type: "text", text: e instanceof StepError ? e.message : "Unexpected error (see the MCP container log)" }], isError: true };
    }
  };
}

const READ_ONLY = { readOnlyHint: true };

function registerTools(server) {
  const add = (name, title, description, inputSchema, fn) =>
    server.registerTool(name, { title, description, inputSchema, annotations: READ_ONLY }, wrap(fn));

  add(
    "server_status",
    "Server status",
    "unRAID and API versions, uptime, CPU and memory use, array state and capacity, parity check progress, per-disk status, and unread notification counts.",
    {},
    () => tools.serverStatus(),
  );
  add(
    "list_containers",
    "List containers",
    "Every Docker container: image, state, auto start, update available, network and ports. Never includes environment values.",
    { state: z.string().optional().describe("Only this state, e.g. RUNNING or EXITED"), name_contains: z.string().optional() },
    (a) => tools.listContainers(a),
  );
  add(
    "get_container",
    "Get a container",
    "One container: everything list_containers shows, plus mounts and, from its unRAID template, variable NAMES, privileged mode, network and Extra Parameters flag names. Never includes values.",
    { name: z.string().min(1) },
    (a) => tools.getContainer(a),
  );
  add(
    "container_logs",
    "Container logs",
    "The last lines of one container's log, with secret-looking values hidden. The filter can't catch everything: don't repeat log content beyond what the task needs.",
    { name: z.string().min(1), lines: z.number().int().min(1).optional().describe(`Default 50, at most ${config.maxLogLines}`) },
    (a) => tools.containerLogs(a),
  );
  add(
    "list_dependencies",
    "List dependencies",
    "For each unRAID template: the hosts and ports its variables point at, and which container publishes that port. Only host, port and variable name leave the value, never credentials. Settings in an app's own files aren't visible.",
    {},
    () => tools.listDependencies(),
  );
  add("list_shares", "List shares", "User shares: size, free and used space, cache setting, included and excluded disks.", {}, () => tools.listShares());
  add(
    "list_disks",
    "List disks",
    "Physical disks: device, size, temperature, SMART status and whether they spin. This may wake sleeping drives, so call it only when disk health is the question; server_status covers everyday checks.",
    {},
    () => tools.listDisks(),
  );
  add(
    "list_notifications",
    "List notifications",
    "unRAID's notifications, newest as unRAID returns them, with secret-looking values hidden.",
    { limit: z.number().int().min(1).optional().describe("Default 20, at most 100"), archived: z.boolean().optional() },
    (a) => tools.listNotifications(a),
  );
  add("parity_history", "Parity history", "Past parity checks: date, duration, speed, status and errors.", { limit: z.number().int().min(1).optional().describe("Default 10") }, (a) => tools.parityHistory(a));
}

function send(res, code, data) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const httpServer = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0].replace(/\/+$/, "") || "/";

  if (url === "/health") {
    return send(res, 200, { ok: true });
  }

  if (url !== "/mcp" && url !== "/") {
    return send(res, 404, { error: "not found" });
  }

  if (!allowed(req.headers.authorization)) {
    return send(res, 401, { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  }

  const chunks = [];
  let size = 0;

  try {
    for await (const chunk of req) {
      size += chunk.length;

      if (size > MAX_BODY_BYTES) {
        res.setHeader("Connection", "close");
        return send(res, 413, { jsonrpc: "2.0", error: { code: -32600, message: "Request body too large" }, id: null });
      }

      chunks.push(chunk);
    }
  } catch {
    return; // The client went away mid-request.
  }

  let body;

  try {
    body = size ? JSON.parse(Buffer.concat(chunks).toString("utf-8")) : undefined;
  } catch {
    return send(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
  }

  // Stateless Streamable HTTP: a fresh server and transport per request.
  const server = new McpServer(INFO);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close();
    server.close();
  });

  try {
    registerTools(server);
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    console.error(e);

    if (!res.headersSent) {
      send(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

if (require.main === module) {
  httpServer.listen(config.port, () => {
    console.log(`${INFO.name} MCP ${INFO.version} on :${config.port}/mcp`);

    if (!config.mcpToken) {
      console.log("MCP_TOKEN is not set: every /mcp request is refused (401).");
    }
  });
}

module.exports = { httpServer, registerTools };
