# Private mailbox MCP deployment contract

The MCP service is a separate, stateless adapter beside the mailbox. It has no
database, OAuth discovery, callback, client registration, client-held secret,
Cloudflare route, or public endpoint. The mailbox HTTP API remains the
authority for every channel, revision, asset, target, and credential action.

## Build and configuration

Build from the repository root; the root build context is required for the
shared protocol workspace:

```bash
docker build -f packages/mcp/Dockerfile --tag irudd-le/mailbox-mcp:local .
```

| Setting | Default | Operator contract |
| --- | --- | --- |
| `MCP_MAILBOX_URL` | none | Required private URL of the canonical mailbox API. |
| `MCP_MAILBOX_ADMIN_TOKEN` | none | Required dedicated mailbox `admin` credential, supplied only through the deployment secret store. It is sent only as the mailbox Bearer credential. |
| `MCP_LISTEN_HOST` | `0.0.0.0` | Bind address inside the container. |
| `MCP_LISTEN_PORT` | `8081` | Container port. Keep the container mapping consistent with it. |

The image listens on its container interface so its private reverse proxy can
reach it. The later host deployment must map that port only to host loopback,
then configure a non-overlapping Tailscale Serve route to `/mcp`. Never use
Funnel, Cloudflare, Cloudflare Tunnel, public DNS, or a public port mapping for
this endpoint. Tailnet Serve configuration, deployment-secret creation, and
the production verification are owned by #80, not this image contract.

`GET /healthz` and `GET /readyz` are intentionally non-sensitive. Native MCP
clients may call `/mcp` without an `Origin` header; every request carrying one
is refused. No route other than `/mcp`, `/healthz`, and `/readyz` is served.

## Authoring and safety workflow

Use `preview_revision` by default, then show its full draft to the user before
calling `publish_revision`. Skip preview only when the user explicitly asks to
compose and publish. Preview validates exactly the publication input and never
makes a mailbox request, persists a draft, or keeps session state.

`upload_asset` accepts only already-final PNG or WebP bytes, base64 encoded,
up to 1 MiB. It does not accept source-image batches, convert images, invoke a
visual processor, or add a richer stored wire format. Before an agent sends a
source-image batch to any third-party visual processor, it must obtain named,
per-batch user permission that identifies both the provider and the purpose.

`pair_target`, `rollback_revision`, and `revoke_credential` require
`confirm: true`; without it they return an operation-specific confirmation
summary and make no mailbox request. Credential creation returns its generated
secret exactly once. Keep it out of logs, source control, MCP client settings,
and shell history.
