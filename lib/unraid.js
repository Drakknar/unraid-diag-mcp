// Calls unRAID's GraphQL API. Queries name every field they read, so nothing else can reach a tool's answer.
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const { config, StepError } = require("./config");

const TIMEOUT_MS = 90000;

function tlsOptions() {
  const ca = fs.readFileSync(config.certFile);
  const pinned = new crypto.X509Certificate(ca).fingerprint256;

  return {
    ca,
    checkServerIdentity: (_host, cert) => (cert.fingerprint256 === pinned ? undefined : new Error("unRAID's certificate is not the pinned one")),
  };
}

function post(body) {
  const url = new URL(`${config.unraidUrl}/graphql`);
  const plain = url.protocol === "http:";

  if (plain && !config.allowHttp) {
    throw new StepError("UNRAID_URL must use https");
  }

  const options = {
    method: "POST",
    timeout: TIMEOUT_MS,
    headers: { "content-type": "application/json", "x-api-key": config.unraidKey },
    ...(plain ? {} : tlsOptions()),
  };

  return new Promise((resolve, reject) => {
    const req = (plain ? http : https).request(url, options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new StepError("unRAID's API did not answer in time")));
    req.on("error", reject);
    req.end(body);
  });
}

async function query(text) {
  let parsed;

  try {
    parsed = JSON.parse(await post(JSON.stringify({ query: text })));
  } catch (e) {
    if (e instanceof StepError) {
      throw e;
    }

    throw new StepError(`unRAID's API can't be reached (${e.code || e.name})`);
  }

  if (parsed.errors?.length) {
    throw new StepError(`unRAID's API refused: ${parsed.errors.map((x) => x.message).join("; ").slice(0, 300)}`);
  }

  return parsed.data;
}

module.exports = { query };
