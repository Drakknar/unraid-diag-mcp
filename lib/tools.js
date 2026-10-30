// Each function reads named fields only and returns plain data for one tool.
const { config, StepError } = require("./config");
const { query } = require("./unraid");
const { redact } = require("./redact");
const { templateInfo } = require("./templates");

const nameOf = (c) => (c.names?.[0] || "").replace(/^\//, "");

async function serverStatus() {
  const d = await query(`{
    info { os { platform distro release uptime } versions { core { unraid api kernel } } }
    metrics { cpu { percentTotal } memory { percentTotal used total } }
    array {
      state
      capacity { kilobytes { free used total } }
      parityCheckStatus { status progress errors running }
      parities { name status temp numErrors isSpinning }
      disks { name status temp numErrors fsType size fsFree fsUsed isSpinning }
      caches { name status temp numErrors fsType size fsFree fsUsed isSpinning }
    }
    notifications { overview { unread { total info warning alert } } }
  }`);

  return d;
}

async function allContainers() {
  const d = await query(`{ docker { containers {
    id names image state status created autoStart isUpdateAvailable isOrphaned
    ports { ip privatePort publicPort type }
    hostConfig { networkMode }
    mounts
  } } }`);

  return d.docker.containers;
}

const summary = (c) => ({
  name: nameOf(c),
  image: c.image,
  state: c.state,
  status: c.status,
  auto_start: c.autoStart,
  update_available: c.isUpdateAvailable,
  orphaned: c.isOrphaned,
  network: c.hostConfig?.networkMode,
  ports: (c.ports || []).map((p) => ({ ip: p.ip, container: p.privatePort, host: p.publicPort, type: p.type })),
});

async function listContainers({ state, name_contains: part }) {
  const all = (await allContainers()).map(summary);

  return {
    containers: all.filter(
      (c) => (!state || c.state === state.toUpperCase()) && (!part || c.name.toLowerCase().includes(part.toLowerCase())),
    ),
  };
}

async function findContainer(name) {
  const c = (await allContainers()).find((x) => nameOf(x) === name);

  if (!c) {
    throw new StepError(`No container named "${name}"`);
  }

  return c;
}

async function getContainer({ name }) {
  const c = await findContainer(name);

  return {
    ...summary(c),
    created: c.created,
    mounts: (c.mounts || []).map((m) => ({ container: m.Destination, host: m.Source, writable: m.RW, type: m.Type })),
    template: templateInfo(name),
  };
}

async function containerLogs({ name, lines = 50 }) {
  const c = await findContainer(name);
  const tail = Math.min(Math.max(1, Math.trunc(lines)), config.maxLogLines);
  // The id comes from the API's own list, so it is safe to put in the query.
  const d = await query(`{ docker { logs(id: ${JSON.stringify(c.id)}, tail: ${tail}) { lines { timestamp message } } } }`);

  return {
    name,
    note: "Secret-looking values are hidden, but a log can still hold something the filter doesn't recognise.",
    lines: d.docker.logs.lines.map((l) => ({ time: l.timestamp, message: redact(l.message) })),
  };
}

async function listShares() {
  const d = await query("{ shares { name free used size cache include exclude } }");

  return { shares: d.shares };
}

// Not part of server_status: unRAID may have to wake sleeping drives to answer this.
async function listDisks() {
  const d = await query("{ disks { name device size temperature smartStatus interfaceType isSpinning } }");

  return { disks: d.disks };
}

async function listNotifications({ limit = 20, archived = false }) {
  const d = await query(`{ notifications { list(filter: { type: ${archived ? "ARCHIVE" : "UNREAD"}, offset: 0, limit: ${Math.min(Math.max(1, Math.trunc(limit)), 100)} }) {
    title subject description importance timestamp
  } } }`);

  return {
    notifications: d.notifications.list.map((n) => ({
      time: n.timestamp,
      importance: n.importance,
      title: redact(n.title),
      subject: redact(n.subject),
      description: redact(n.description),
    })),
  };
}

async function parityHistory({ limit = 10 }) {
  const d = await query("{ parityHistory { date duration speed status errors } }");

  return { history: d.parityHistory.slice(0, Math.min(Math.max(1, Math.trunc(limit)), 200)) };
}

module.exports = { serverStatus, listContainers, getContainer, containerLogs, listShares, listDisks, listNotifications, parityHistory };
