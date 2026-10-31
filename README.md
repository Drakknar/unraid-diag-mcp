# unraid-diag MCP

Read-only MCP server (Streamable HTTP, stateless, `POST /mcp`) for unRAID, using the official GraphQL API. It has no write tools and never mounts the Docker socket.

## Tools

`server_status`, `list_containers`, `get_container`, `container_logs`, `list_dependencies`, `port_drift`, `list_shares`, `list_disks`, `list_notifications`, `parity_history`.

Every query names its fields, so environment values, serial numbers and machine IDs never reach an answer. `get_container` reads the container's unRAID template for variable names and flags only. Logs and notifications pass through a filter that hides secret-looking values; it can't catch everything. `list_disks` may wake sleeping drives, so everyday checks should use `server_status`.

## Container

Image: `ghcr.io/drakknar/unraid-diag-mcp`, port 8080.

| Setting | Value |
|---|---|
| `MCP_TOKEN` | required: without it every request gets 401 |
| `UNRAID_URL` | required: the web UI's https address |
| `UNRAID_API_KEY` | required: API key with read access to Docker, Array, Info, Disk, Share and Notifications, no roles |
| `UNRAID_CERT_FILE` | unRAID's certificate as PEM (default `/data/unraid-cert.pem`). Only this exact certificate is accepted |
| `DOCKER_HOST_URL` | optional: a Docker socket proxy allowing only `GET /containers/<name>/logs`. `container_logs` uses it first, since unRAID's API returns nothing for some containers, and falls back to the API. Never point it at a raw socket proxy |
| `TEMPLATES_DIR` | optional: read-only mount of `/boot/config/plugins/dockerMan/templates-user` (default `/templates`) |

## Tests

`node test/tools.test.js` (Node 20+): fake API and templates, real MCP client.
