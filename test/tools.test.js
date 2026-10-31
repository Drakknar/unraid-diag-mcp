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

// A file name in another case than the container (as CA creates them), and -p bindings in Extra Parameters.
fs.writeFileSync(
  path.join(ROOT, "my-Closed-App.xml"),
  `<?xml version="1.0"?><Container><Name>closed-app</Name><Network>bridge</Network><ExtraParams>--restart=always -e HIDDEN=${FAKE} -p 172.17.0.1:9001:80 -p 7000-7001:7000-7001 -p 7100-7102:80-81</ExtraParams>
  <Config Name="Sync" Target="55555" Type="Port" Mode="tcp">9002</Config></Container>`,
);
fs.writeFileSync(
  path.join(ROOT, "my-stopped.xml"),
  `<?xml version="1.0"?><Container><Name>stopped</Name><Network>bridge</Network><ExtraParams></ExtraParams><Config Name="Web" Target="80" Type="Port" Mode="tcp">9100</Config></Container>`,
);

// A custom bridge network publishes like the default one; a network tied to a host interface publishes nothing.
fs.writeFileSync(
  path.join(ROOT, "my-private.xml"),
  `<?xml version="1.0"?><Container><Name>private</Name><Network>app-net</Network><ExtraParams>-p 172.17.0.1:7200-7201:7200-7201</ExtraParams><Config Name="Web" Target="80" Type="Port" Mode="tcp">9200</Config></Container>`,
);
fs.writeFileSync(
  path.join(ROOT, "my-macvlan.xml"),
  `<?xml version="1.0"?><Container><Name>macvlan</Name><Network>br0</Network><ExtraParams></ExtraParams><Config Name="Web" Target="80" Type="Port" Mode="tcp">9300</Config></Container>`,
);
fs.writeFileSync(
  path.join(ROOT, "my-private-stopped.xml"),
  `<?xml version="1.0"?><Container><Name>private-stopped</Name><Network>app-net</Network><ExtraParams></ExtraParams><Config Name="Web" Target="80" Type="Port" Mode="tcp">9400</Config></Container>`,
);

const CONTAINER = {
  id: "abc:def", names: ["/app"], image: "img:1", state: "RUNNING", status: "Up", created: 1, autoStart: true, isUpdateAvailable: false, isOrphaned: false,
  ports: [{ ip: "0.0.0.0", privatePort: 80, publicPort: 8080, type: "TCP" }], hostConfig: { networkMode: "bridge" },
  mounts: [{ Destination: "/data", Source: "/mnt/x", RW: true, Type: "bind", Propagation: "rprivate" }],
  // Fields no query may ask for: a request for them makes the fake fail the test.
};

const base = { state: "RUNNING", status: "Up", created: 1, autoStart: true, isUpdateAvailable: false, isOrphaned: false, hostConfig: { networkMode: "bridge" }, mounts: [] };
const CLOSED = {
  ...base, id: "c2", names: ["/closed-app"], image: "i",
  ports: [
    { ip: "0.0.0.0", privatePort: 80, publicPort: 9001, type: "TCP" }, // came back on the LAN
    { ip: "0.0.0.0", privatePort: 55555, publicPort: 9002, type: "TCP" },
    { ip: "", privatePort: 443, publicPort: null, type: "TCP" },
  ],
};
const STOPPED = { ...base, id: "c3", names: ["/stopped"], image: "i", state: "EXITED", status: "Exited", ports: [] };
const QUIET = { ...base, id: "c4", names: ["/quiet"], image: "i", ports: [] };

const PRIVATE = {
  ...base, id: "c5", names: ["/private"], image: "i", hostConfig: { networkMode: "app-net" },
  ports: [
    { ip: "172.17.0.1", privatePort: 7200, publicPort: 7200, type: "TCP" },
    { ip: "172.17.0.1", privatePort: 7201, publicPort: 7201, type: "TCP" },
    { ip: "0.0.0.0", privatePort: 5432, publicPort: 5432, type: "TCP" }, // should be private, and it isn't
  ],
};
const MACVLAN = { ...base, id: "c6", names: ["/macvlan"], image: "i", hostConfig: { networkMode: "br0" }, ports: [] };
const PRIVATE_STOPPED = { ...base, id: "c7", names: ["/private-stopped"], image: "i", state: "EXITED", status: "Exited", hostConfig: { networkMode: "app-net" }, ports: [] };

const api = http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    const q = JSON.parse(b).query;
    queries.push(q);
    assert.strictEqual(req.headers["x-api-key"], "test-key");
    let data = {};
    if (q.includes('"c4"')) data = { docker: { logs: { lines: [] } } };
    else if (q.includes("logs(")) data = { docker: { logs: { lines: [{ timestamp: "t3", message: "newest" }, { timestamp: "t1", message: `start password=${FAKE} ok` }, { timestamp: "t2", message: "plain line" }] } } };
    else if (q.includes("containers")) data = { docker: { containers: [CONTAINER, CLOSED, STOPPED, QUIET, PRIVATE, MACVLAN, PRIVATE_STOPPED] } };
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
  const { config } = require("../lib/config");
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
  assert.strictEqual(names.length, 10);
  assert(names.every((t) => t.annotations.readOnlyHint), "every tool is read-only");

  await call("server_status");
  assert(!queries.at(-1).includes("disks { name device"), "server_status must not use the top-level disks query");
  assert(!queries.some((q) => /mutation/.test(q)));

  const list = await call("list_containers", { state: "running" });
  assert.strictEqual(list.containers[0].name, "app");
  assert.deepStrictEqual((await call("list_containers", { state: "exited" })).containers.map((c) => c.name), ["stopped", "private-stopped"]);

  const one = await call("get_container", { name: "app" });
  assert.deepStrictEqual(one.template.variables[0], { name: "API_KEY", masked: true });
  assert.deepStrictEqual(one.template.extra_param_flags, ["--cap-add", "-e"]);
  assert.strictEqual(one.template.privileged, true);
  assert.strictEqual(one.mounts[0].host, "/mnt/x");
  assert.strictEqual(one.mounts[0].Propagation, undefined);

  assert.strictEqual((await call("get_container", { name: "closed-app" })).template.file, "my-Closed-App.xml", "matched by <Name>, not file name");

  const ports = await call("port_drift");
  const byName = Object.fromEntries(ports.containers.map((c) => [c.name, c]));
  assert.deepStrictEqual(ports.with_drift, ["app", "closed-app", "private"]);
  assert.deepStrictEqual(byName.app.drift, [{ port: "8080/TCP", expected: "not in template", live: "0.0.0.0" }]);
  assert.deepStrictEqual(byName["closed-app"].drift.slice(0, 1), [{ port: "9001/TCP", expected: "172.17.0.1", live: "0.0.0.0" }]);
  assert.deepStrictEqual(byName["closed-app"].drift.slice(1).map((d) => d.port), ["7000/TCP", "7001/TCP"], "a range is read as its ports");
  assert.deepStrictEqual(byName["closed-app"].lan_ports, ["9001/TCP", "9002/TCP"]);
  assert.strictEqual(byName["closed-app"].unread_port_settings, 1);
  assert.deepStrictEqual(byName.stopped.lan_ports, ["9100/TCP"], "a stopped container is judged by its template");
  assert.deepStrictEqual(byName.stopped.drift, []);
  assert.strictEqual(byName.quiet.has_template, false);
  assert.deepStrictEqual(byName.private.drift, [
    { port: "9200/TCP", expected: "0.0.0.0", live: "not published" },
    { port: "5432/TCP", expected: "not in template", live: "0.0.0.0" },
  ], "a custom network is compared too, and its range matches");
  assert.deepStrictEqual(byName.macvlan.drift, [], "a host interface network publishes nothing");
  assert.deepStrictEqual(byName["private-stopped"].lan_ports, ["9400/TCP"]);

  const deps = (await call("list_dependencies")).dependencies.find((c) => c.container === "app");
  assert.strictEqual(deps.container, "app");
  assert.deepStrictEqual(deps.targets.find((x) => x.variable === "DATABASE_URL"), { variable: "DATABASE_URL", host: "10.0.0.5", port: 8080, published_by: "app" });
  assert.deepStrictEqual(deps.targets.find((x) => x.variable === "OTHER_URL"), { variable: "OTHER_URL", host: "10.0.0.6", port: 81 });
  assert.strictEqual(deps.targets.find((x) => x.variable === "DB_HOST").host, "db.local");
  assert.strictEqual(deps.targets.find((x) => x.variable === "DB_PORT").port, 5432);
  assert(!deps.targets.some((x) => x.variable === "DB_PASS" || x.variable === "API_KEY"));

  const logs = await call("container_logs", { name: "app", lines: 100000 });
  assert(logs.lines[0].message.includes("[hidden]") && logs.lines[1].message === "plain line" && logs.lines[2].message === "newest", "oldest first");
  assert(queries.at(-1).includes("tail: 600"), "asks for more than the capped 200");
  assert.strictEqual(logs.requested, 200);
  assert.strictEqual(logs.returned, 3);
  assert(logs.note.includes("Fewer lines"));
  const newest = await call("container_logs", { name: "app", lines: 1 });
  assert.deepStrictEqual(newest.lines.map((l) => l.message), ["newest"], "keeps the newest");
  assert((await call("container_logs", { name: "quiet" })).note.includes("returned no lines"), "an empty answer is called out");

  // A log-only Docker proxy comes first when set, and the API takes over when it fails.
  const dockerSeen = [];
  let dockerStatus = 200;
  const frame = (text) => {
    const head = Buffer.alloc(8);
    head[0] = 1;
    head.writeUInt32BE(Buffer.byteLength(text), 4);
    return Buffer.concat([head, Buffer.from(text)]);
  };
  const dockerApi = http.createServer((req, res) => {
    dockerSeen.push(`${req.method} ${req.url}`);
    res.statusCode = dockerStatus;
    res.end(dockerStatus === 200 ? Buffer.concat([frame("2026-01-01T00:00:00Z first\n"), frame(`2026-01-01T00:00:01Z password=${FAKE} second\n`)]) : "refused");
  });
  await new Promise((r) => dockerApi.listen(0, "127.0.0.1", r));
  config.dockerHost = `http://127.0.0.1:${dockerApi.address().port}`;
  const direct = await call("container_logs", { name: "quiet", lines: 5 });
  assert.strictEqual(direct.source, "docker");
  assert.deepStrictEqual(direct.lines[0], { time: "2026-01-01T00:00:00Z", message: "first" });
  assert(direct.lines[1].message.includes("[hidden]"), "Docker lines are filtered too");
  assert.strictEqual(dockerSeen.at(-1), "GET /containers/quiet/logs?stdout=1&stderr=1&timestamps=1&tail=5");
  dockerStatus = 403;
  const fallback = await call("container_logs", { name: "app", lines: 1 });
  assert.strictEqual(fallback.source, "unraid_api");
  assert(fallback.note.includes("Docker logs failed"));
  assert(dockerSeen.every((r) => r.startsWith("GET /containers/")), "only log reads");
  config.dockerHost = "";
  dockerApi.close();

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
    ['{\"password\":\"fakevalue1\",\"user\":\"a\"}', "fakevalue1"],
    ["tool --password fakevalue2 --verbose", "fakevalue2"],
    ["tool --token fakevalue3", "fakevalue3"],
    ["tool --api-key=fakevalue4", "fakevalue4"],
    ["PGPASSWORD fakevalue5 psql", "fakevalue5"],
    ["Authorization: Token fakevalue6", "fakevalue6"],
    ["Authorization: Custom fakevalue7", "fakevalue7"],
    ["Cookie: a=1; session=fakevalue8", "fakevalue8"],
    ["password=two fakewords9", "fakewords9"],
    ["postgres://user:fake/value10@db/x", "value10"],
    ["found AKIAFAKEFAKEFAKEFAKE here", "AKIAFAKEFAKEFAKEFAKE"],
    ["password\x1b[0m=fakevalue11", "fakevalue11"],
  ]) {
    assert(!redact(input).includes(leaked), input);
  }
  assert.strictEqual(redact("GET /health 200 in 3ms"), "GET /health 200 in 3ms");
  assert.strictEqual(redact("user=alice logged in"), "user=alice logged in");
  assert.strictEqual(redact("wrong password for alice"), "wrong password for alice");
  assert.strictEqual(redact("http://host:8080/path"), "http://host:8080/path");
  assert(redact('{"password":"x1","user":"alice"}').includes("alice"), "a JSON neighbour stays");

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
