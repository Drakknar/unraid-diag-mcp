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

module.exports = { templateInfo, extraFlags };
