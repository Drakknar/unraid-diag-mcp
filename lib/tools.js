// Each function reads named fields only and returns plain data for one tool.
const { config, StepError } = require("./config");
const { query } = require("./unraid");
const { redact } = require("./redact");
const docker = require("./docker");
const { templateInfo, templatePorts, dependencies } = require("./templates");

const LOG_OVERFETCH = 3;

const nameOf = (c) => (c.names?.[0] || "").replace(/^\//, "");

// The API's sizes are bare numbers in two different units, so the unit goes in the name: models read them as bytes.
const arrayDisk = ({ size, fsFree, fsUsed, ...rest }) => ({ ...rest, sizeKb: size, fsFreeKb: fsFree, fsUsedKb: fsUsed });
const share = ({ free, used, size, ...rest }) => ({ ...rest, freeKb: free, usedKb: used, sizeKb: size });
const physicalDisk = ({ size, ...rest }) => ({ ...rest, sizeBytes: size });

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

  return { ...d, array: { ...d.array, disks: d.array.disks?.map(arrayDisk), caches: d.array.caches?.map(arrayDisk) } };
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

// The API often returns fewer lines than the tail it was given, and not always in order. Asking for more and
// keeping the newest gets closer to the number wanted; what it still can't deliver is reported, not hidden.
async function apiLogs(c, wanted) {
  // The id comes from the API's own list, so it is safe to put in the query.
  const d = await query(`{ docker { logs(id: ${JSON.stringify(c.id)}, tail: ${wanted * LOG_OVERFETCH}) { lines { timestamp message } } } }`);

  return d.docker.logs.lines
    .map((l, i) => ({ l, i }))
    .sort((a, b) => String(a.l.timestamp).localeCompare(String(b.l.timestamp)) || a.i - b.i)
    .slice(-wanted)
    .map(({ l }) => l);
}

// Docker first when a log-only proxy is set, because it is complete; unRAID's API is the fallback.
async function containerLogs({ name, lines = 50 }) {
  const c = await findContainer(name);
  const wanted = Math.min(Math.max(1, Math.trunc(lines)), config.maxLogLines);
  const notes = ["Secret-looking values are hidden, but a log can still hold something the filter doesn't recognise."];
  let got;
  let source = "docker";

  if (config.dockerHost) {
    try {
      got = await docker.logs(name, wanted);
    } catch (e) {
      notes.push(`Docker logs failed (${redact(e.message)}), so these come from the unRAID API.`);
    }
  }

  if (!got) {
    source = "unraid_api";
    got = await apiLogs(c, wanted);
  }

  if (!got.length && c.state === "RUNNING") {
    notes.push(source === "docker" ? "Docker returned no lines: this container hasn't logged recently." : "The unRAID API returned no lines for this running container. That doesn't mean its log is empty: read it in the Docker tab.");
  } else if (source === "unraid_api" && got.length < wanted) {
    notes.push("Fewer lines than asked for: the log is shorter, or the unRAID API left lines out, so don't treat this as complete.");
  }

  return {
    name,
    source,
    requested: wanted,
    returned: got.length,
    note: notes.join(" "),
    lines: got.map((l) => ({ time: l.timestamp, message: redact(l.message) })),
  };
}

async function listShares() {
  const d = await query("{ shares { name free used size cache include exclude } }");

  return { shares: d.shares.map(share) };
}

// Not part of server_status: unRAID may have to wake sleeping drives to answer this.
async function listDisks() {
  const d = await query("{ disks { name device size temperature smartStatus interfaceType isSpinning } }");

  return { disks: d.disks.map(physicalDisk) };
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

// Which container each template's addresses land on, so a port can be closed knowing who uses it.
async function listDependencies() {
  const deps = dependencies();

  if (!deps) {
    throw new StepError("No templates mounted");
  }

  const byPort = new Map();

  for (const c of await allContainers()) {
    for (const p of c.ports || []) {
      if (p.publicPort) {
        byPort.set(p.publicPort, nameOf(c));
      }
    }
  }

  return {
    note: "From container templates only. Settings in an app's own files, and devices outside Docker, don't show here.",
    dependencies: deps.map((c) => ({
      container: c.container,
      targets: c.targets.map((t) => ({ ...t, ...(byPort.has(t.port) ? { published_by: byPort.get(t.port) } : {}) })),
    })),
  };
}

const portKey = (p) => `${p.host}/${p.type}`;
// Default and custom bridges publish ports. Host, none, another container's network and networks tied to a host
// interface (unRAID's br0, eth0, bond0, wg0) don't.
const publishes = (network) => Boolean(network) && !/^(?:host$|none$|container:|(?:br|eth|bond|wg)\d)/.test(network);
const onLan = (p) => !["127.0.0.1", "::1", "172.17.0.1"].includes(p.ip);

// Every container, stopped ones too: what is open to the LAN, and where the running container differs from its
// template. A stopped container is judged by its template, since that is what it would publish when started.
async function portDrift() {
  const out = [];

  for (const c of await allContainers()) {
    const name = nameOf(c);
    const tmpl = templatePorts(name);
    const running = c.state === "RUNNING";
    const live = new Map((c.ports || []).filter((p) => p.publicPort).map((p) => {
      const port = { ip: p.ip || "0.0.0.0", host: p.publicPort, container: p.privatePort, type: p.type };

      return [portKey(port), port];
    }));
    const published = tmpl && (publishes(tmpl.network) || tmpl.network === "host") ? tmpl.ports : [];
    const expected = new Map(published.map((p) => [portKey(p), p]));
    const drift = [];

    if (running && tmpl && publishes(tmpl.network)) {
      for (const [key, p] of expected) {
        const now = live.get(key);

        if (!now) {
          drift.push({ port: key, expected: p.ip, live: "not published" });
        } else if (now.ip !== p.ip) {
          drift.push({ port: key, expected: p.ip, live: now.ip });
        }
      }

      for (const [key, p] of live) {
        if (!expected.has(key)) {
          drift.push({ port: key, expected: "not in template", live: p.ip });
        }
      }
    }

    const shown = running ? [...live.values()] : published;

    out.push({
      name,
      state: c.state,
      has_template: Boolean(tmpl),
      lan_ports: shown.filter(onLan).map(portKey).sort(),
      bridge_ports: shown.filter((p) => p.ip === "172.17.0.1").map(portKey).sort(),
      drift,
      ...(tmpl?.unread ? { unread_port_settings: tmpl.unread } : {}),
    });
  }

  out.sort((a, b) => a.name.localeCompare(b.name));

  return {
    note: "lan_ports: reachable from the LAN (for a stopped container, when started). Host network containers can't be fully judged from here, and unread_port_settings counts -p values that couldn't be read.",
    with_drift: out.filter((c) => c.drift.length).map((c) => c.name),
    containers: out,
  };
}

module.exports = { portDrift, listDependencies, serverStatus, listContainers, getContainer, containerLogs, listShares, listDisks, listNotifications, parityHistory };
