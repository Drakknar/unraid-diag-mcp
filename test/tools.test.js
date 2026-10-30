// Test of unraid-diag-mcp: fake GraphQL API and fake templates, real MCP client.
// Run with Node 20+: node test/tools.test.js
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "unraid-diag-test-"));
const FAKE = "fake-value-that-must-not-appear";
const queries = [];
fs.writeFileSync(
  path.join(ROOT, "my-app.xml"),
  `<?xml version="1.0"?><Container><Privileged>true</Privileged><Network>bridge</Network><ExtraParams>--cap-add=NET_ADMIN -e HIDDEN=${FAKE}</ExtraParams>
  <Config Name="Key" Target="API_KEY" Type="Variable" Mask="true">${FAKE}</Config><Config Name="Data" Target="/data" Type="Path">/mnt/x</Config>
  <Config Name="Db" Target="DATABASE_URL" Type="Variable">postgres://user:${FAKE}@10.0.0.5:8080/db?x=${FAKE}</Config>
  <Config Name="Url" Target="OTHER_URL" Type="Variable">http://10.0.0.6:81/path</Config>
  <Config Name="Host" Target="DB_HOST" Type="Variable">db.local</Config>
  <Config Name="Port" Target="DB_PORT" Type="Variable">5432</Config>
  <Config Name="Pass" Target="DB_PASS" Type="Variable">${FAKE}</Config>
  </Container>`,
);

const CONTAINER = {
  id: "abc:def", names: ["/app"], image: "img:1", state: "RUNNING", status: "Up", created: 1, autoStart: true, isUpdateAvailable: false, isOrphaned: false,
  ports: [{ ip: "0.0.0.0", privatePort: 80, publicPort: 8080, type: "TCP" }], hostConfig: { networkMode: "bridge" },
  mounts: [{ Destination: "/data", Source: "/mnt/x", RW: true, Type: "bind", Propagation: "rprivate" }],
  // Fields no query may ask for: a request for them makes the fake fail the test.
};

const api = http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    const q = JSON.parse(b).query;
    queries.push(q);
    assert.strictEqual(req.headers["x-api-key"], "test-key");
    let data = {};
    if (q.includes("logs(")) data = { docker: { logs: { lines: [{ timestamp: "t", message: `start password=${FAKE} ok` }, { timestamp: "t", message: "plain line" }] } } };
    else if (q.includes("containers")) data = { docker: { containers: [CONTAINER] } };
    else if (q.includes("shares")) data = { shares: [{ name: "media", free: 1, used: 2, size: 3, cache: true, include: [], exclude: [] }] };
    else if (q.includes("parityHistory")) data = { parityHistory: [{ date: "d", duration: 1, speed: "s", status: "OK", errors: 0 }, { date: "e" }] };
    else if (q.includes("disks {") && !q.includes("array")) data = { disks: [{ name: "d1" }] };
    else if (q.includes("list(filter")) data = { notifications: { list: [{ title: "t", subject: `token: ${FAKE}`, description: "d", importance: "INFO", timestamp: "x" }] } };
    else data = { array: { state: "STARTED" } };
    res.end(JSON.stringify({ data }));
  });
});

(async () => {
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  Object.assign(process.env, {
    UNRAID_URL: `http://127.0.0.1:${api.address().port}`, UNRAID_API_KEY: "test-key", UNRAID_ALLOW_HTTP: "1", MCP_TOKEN: "tok", TEMPLATES_DIR: ROOT, PORT: "0",
  });
  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const { httpServer } = require("../server");
  const { redact } = require("../lib/redact");
  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${httpServer.address().port}/mcp`;

  const noToken = await fetch(url, { method: "POST", body: "{}" });
  assert.strictEqual(noToken.status, 401);

  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: "Bearer tok" } } }));
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    assert(!r.isError, `${name}: ${r.content[0].text}`);
    assert(!r.content[0].text.includes(FAKE), `${name} leaked a value`);
    return JSON.parse(r.content[0].text);
  };

  const names = (await client.listTools()).tools;
  assert.strictEqual(names.length, 9);
  assert(names.every((t) => t.annotations.readOnlyHint), "every tool is read-only");

  await call("server_status");
  assert(!queries.at(-1).includes("disks { name device"), "server_status must not use the top-level disks query");
  assert(!queries.some((q) => /mutation/.test(q)));

  const list = await call("list_containers", { state: "running" });
  assert.strictEqual(list.containers[0].name, "app");
  assert.strictEqual((await call("list_containers", { state: "exited" })).containers.length, 0);

  const one = await call("get_container", { name: "app" });
  assert.deepStrictEqual(one.template.variables[0], { name: "API_KEY", masked: true });
  assert.deepStrictEqual(one.template.extra_param_flags, ["--cap-add", "-e"]);
  assert.strictEqual(one.template.privileged, true);
  assert.strictEqual(one.mounts[0].host, "/mnt/x");
  assert.strictEqual(one.mounts[0].Propagation, undefined);

  const deps = (await call("list_dependencies")).dependencies[0];
  assert.strictEqual(deps.container, "app");
  assert.deepStrictEqual(deps.targets.find((x) => x.variable === "DATABASE_URL"), { variable: "DATABASE_URL", host: "10.0.0.5", port: 8080, published_by: "app" });
  assert.deepStrictEqual(deps.targets.find((x) => x.variable === "OTHER_URL"), { variable: "OTHER_URL", host: "10.0.0.6", port: 81 });
  assert.strictEqual(deps.targets.find((x) => x.variable === "DB_HOST").host, "db.local");
  assert.strictEqual(deps.targets.find((x) => x.variable === "DB_PORT").port, 5432);
  assert(!deps.targets.some((x) => x.variable === "DB_PASS" || x.variable === "API_KEY"));

  const logs = await call("container_logs", { name: "app", lines: 100000 });
  assert(logs.lines[0].message.includes("[hidden]") && logs.lines[1].message === "plain line");
  assert(queries.at(-1).includes("tail: 200"), "tail is capped");

  const missing = await client.callTool({ name: "container_logs", arguments: { name: "../etc" } });
  assert(missing.isError);

  await call("list_shares");
  await call("list_disks");
  assert((await call("list_notifications")).notifications[0].subject.includes("[hidden]"));
  assert.strictEqual((await call("parity_history", { limit: 1 })).history.length, 1);
  assert(!queries.some((q) => /serialNum|machineId|mutation|\benv\b/i.test(q)), "no query asks for identifiers or env");

  for (const [input, leaked] of [
    ["Authorization: Bearer abcdefgh12345678", "abcdefgh12345678"],
    ["postgres://user:hunter22222@db/x", "hunter22222"],
    ['{"apiKey": "qwertyuiop"}', "qwertyuiop"],
    ["MY_DB_PASSWORD=swordfish9", "swordfish9"],
    ["id 0123456789abcdef0123456789abcdef seen", "0123456789abcdef0123456789abcdef"],
    ["eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.sig", "eyJhbGciOiJIUzI1"],
  ]) {
    assert(!redact(input).includes(leaked), input);
  }
  assert.strictEqual(redact("GET /health 200 in 3ms"), "GET /health 200 in 3ms");

  await client.close();
  httpServer.close();
  api.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log("OK");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
