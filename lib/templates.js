// Reads unRAID's container templates, which hold secrets in clear: only names and flags ever leave this file.
const fs = require("fs");
const path = require("path");
const { config } = require("./config");

const unescapeXml = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

function tag(xml, name) {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? unescapeXml(m[1]).trim() : "";
}

function attrs(text) {
  return Object.fromEntries([...text.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], unescapeXml(m[2])]));
}

// Flag names only: "--cap-add=NET_ADMIN -e KEY=value" gives ["--cap-add", "-e"].
function extraFlags(value) {
  return [...new Set([...value.matchAll(/(?:^|\s)(--?[A-Za-z][\w-]*)/g)].map((m) => m[1]))];
}

// null when the container has no template. The file is matched against the listing, never built from the name.
function templateInfo(container) {
  let files;

  try {
    files = fs.readdirSync(config.templatesDir);
  } catch {
    return null;
  }

  const file = files.find((f) => f === `my-${container}.xml`);

  if (!file) {
    return null;
  }

  const xml = fs.readFileSync(path.join(config.templatesDir, file), "utf-8");
  const configs = [...xml.matchAll(/<Config\b([^>]*?)\/?>/g)].map((m) => attrs(m[1]));
  const extra = tag(xml, "ExtraParams");

  return {
    file,
    privileged: tag(xml, "Privileged").toLowerCase() === "true",
    network: tag(xml, "Network"),
    extra_param_flags: extraFlags(extra),
    variables: configs
      .filter((c) => c.Type === "Variable")
      .map((c) => ({ name: c.Target || c.Name, masked: c.Mask === "true" })),
  };
}

const HOST = String.raw`(?:\d{1,3}(?:\.\d{1,3}){3}|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)`;
const URL_HOST = new RegExp(String.raw`[A-Za-z][A-Za-z0-9+.-]*://(?:[^\s/@]*@)?(${HOST})(?::(\d{1,5}))?`, "g");
const BARE_IP = new RegExp(String.raw`(?:^|[\s,;=@])(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?(?=$|[\s,;/])`, "g");
const HOST_NAME = /(?:^|_)(?:HOST|HOSTNAME|SERVER|ENDPOINT_IP)$/i;
const PORT_NAME = /(?:^|_)PORT$/i;

// What one setting points at: only host and port are taken out of the value, never credentials or paths.
function targets(name, value) {
  const found = [...value.matchAll(URL_HOST), ...value.matchAll(BARE_IP)].map((m) => ({ host: m[1], port: m[2] ? Number(m[2]) : null }));

  if (!found.length && HOST_NAME.test(name) && new RegExp(`^${HOST}$`).test(value)) {
    found.push({ host: value, port: null });
  }

  return found;
}

// For each template: where its settings point. Names stay as written; values are never returned.
// App settings kept in the app's own files (a .env, config.php) aren't visible here.
function dependencies() {
  let files;

  try {
    files = fs.readdirSync(config.templatesDir).filter((f) => /^my-.*\.xml$/.test(f));
  } catch {
    return null;
  }

  return files.map((file) => {
    const xml = fs.readFileSync(path.join(config.templatesDir, file), "utf-8");
    const out = [];

    for (const m of xml.matchAll(/<Config\b([^>]*?)>([^<]*)<\/Config>/g)) {
      const a = attrs(m[1]);

      if (a.Type !== "Variable") {
        continue;
      }

      const name = a.Target || a.Name;
      const value = unescapeXml(m[2]).trim();

      for (const t of targets(name, value)) {
        out.push({ variable: name, ...t });
      }

      if (PORT_NAME.test(name) && /^\d{1,5}$/.test(value)) {
        out.push({ variable: name, host: null, port: Number(value) });
      }
    }

    return { container: file.replace(/^my-|\.xml$/g, ""), targets: out };
  }).filter((c) => c.targets.length);
}

module.exports = { templateInfo, extraFlags, dependencies };
