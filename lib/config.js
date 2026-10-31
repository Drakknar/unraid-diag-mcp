// All settings come from the container's environment.
const env = process.env;

// No built-in addresses: a setting this server can't work without stops it at start-up.
function required(name) {
  if (!env[name]) {
    throw new Error(`Environment variable ${name} is required`);
  }

  return env[name];
}

const config = {
  port: Number(env.PORT || 8080),
  mcpToken: env.MCP_TOKEN || "",

  unraidUrl: required("UNRAID_URL").replace(/\/+$/, ""),
  unraidKey: required("UNRAID_API_KEY"),
  // unRAID's own certificate (PEM). Only this exact certificate is accepted, because it is self-signed.
  certFile: env.UNRAID_CERT_FILE || "/data/unraid-cert.pem",
  // Tests only: plain http sends the API key unencrypted.
  allowHttp: env.UNRAID_ALLOW_HTTP === "1",

  // Optional: a Docker socket proxy that allows only log reads. unRAID's API returns no logs for some containers.
  dockerHost: env.DOCKER_HOST_URL || "",

  templatesDir: env.TEMPLATES_DIR || "/templates",
  maxLogLines: Number(env.MAX_LOG_LINES || 200),
};

class StepError extends Error {}

module.exports = { config, StepError };
