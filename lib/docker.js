// Reads container logs from a filtering Docker socket proxy. It is never given the raw socket, and logs are all it asks for.
const http = require("http");
const { config, StepError } = require("./config");

const TIMEOUT_MS = 30000;
const MAX_BYTES = 5 * 1024 * 1024;

function get(path) {
  const url = new URL(path, config.dockerHost);

  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: TIMEOUT_MS }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (c) => {
        size += c.length;
        if (size > MAX_BYTES) {
          req.destroy(new StepError("The Docker log answer is too large"));
        } else {
          chunks.push(c);
        }
      });
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new StepError("The Docker socket proxy did not answer in time")));
    req.on("error", reject);
  });
}

// Containers without a terminal send framed output: 8 bytes (stream, size), then the text.
function demux(buf) {
  const parts = [];
  let i = 0;

  while (i + 8 <= buf.length && buf[i] <= 2 && buf[i + 1] === 0) {
    const len = buf.readUInt32BE(i + 4);
    parts.push(buf.subarray(i + 8, i + 8 + len));
    i += 8 + len;
  }

  return (i === 0 ? buf : Buffer.concat(parts)).toString("utf-8");
}

// Oldest first, as { timestamp, message }. The name comes from unRAID's own list, and is encoded anyway.
async function logs(name, tail) {
  const r = await get(`/containers/${encodeURIComponent(name)}/logs?stdout=1&stderr=1&timestamps=1&tail=${tail}`);

  if (r.status !== 200) {
    throw new StepError(`Docker logs answered ${r.status}`);
  }

  return demux(r.body)
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const gap = line.indexOf(" ");

      return gap > 0 ? { timestamp: line.slice(0, gap), message: line.slice(gap + 1) } : { timestamp: "", message: line };
    });
}

module.exports = { logs };
