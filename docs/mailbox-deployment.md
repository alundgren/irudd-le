# Initial mailbox deployment contract

This is the operator procedure for the constrained first mailbox deployment.
It defines the image and recovery contract for the human deployment work in
#58; it does not register or deploy anything to Piploy, Cloudflare, staging,
production, a Tailnet, or a Raspberry Pi.

## Container contract

The repository-root [`Dockerfile`](../Dockerfile) is the canonical mailbox
deployment Dockerfile. It is distinct from the stateless private MCP image at
[`packages/mcp/Dockerfile`](../packages/mcp/Dockerfile); neither image replaces
the other. Build the mailbox image from a clean repository checkout, using the
repository root as its context:

```bash
docker build --quiet --tag irudd-le/mailbox:local .
```

This root context is required because the image builds the shared protocol
package as well as the mailbox. The runtime image runs as the unprivileged
`node` user and listens on TCP port `8080` by default. It exposes that port and
probes unauthenticated `GET /healthz`. Both
`/healthz` and `/readyz` must return 200 before a reverse proxy admits normal
traffic; they are intentionally available without a mailbox credential.

Mount one persistent volume at `/var/lib/mailbox`. The default database is
`/var/lib/mailbox/mailbox.db`; do not use an ephemeral container filesystem for
it. A replacement `MAILBOX_DATABASE_PATH` must still point into durable
storage, and its parent directory must be writable by the `node` user.

| Setting | Default | Operator contract |
| --- | --- | --- |
| `MAILBOX_DATABASE_PATH` | `/var/lib/mailbox/mailbox.db` | Persistent SQLite state. Back up this volume before upgrades. |
| `MAILBOX_LISTEN_HOST` | `0.0.0.0` | Bind address inside the container. |
| `MAILBOX_LISTEN_PORT` | `8080` | Container port; make the Docker/Piploy port mapping match it. |
| `MAILBOX_ADMIN_BOOTSTRAP_TOKEN` | none | Required only for a new database. Supply a high-entropy secret through the deployment secret store, never an image or command line checked into source. |
| `MAILBOX_MAX_BODY_BYTES` | mailbox default | Optional finite request-size limit. Leave unset unless the deployment has a documented limit. |

On the first successful startup, `MAILBOX_ADMIN_BOOTSTRAP_TOKEN` creates one
admin credential. Subsequent startups ignore that value once an admin record
exists; rotating the environment variable neither rotates nor restores an
admin token. Keep an independently stored admin recovery credential before
revoking credentials. A new empty volume without the bootstrap secret fails
startup intentionally.

The process handles `SIGTERM` and `SIGINT` by closing its HTTP server and
SQLite store before exiting. Configure the platform's shutdown grace period to
allow that exit, and only snapshot the volume after the container has stopped.
Migrations run transactionally during startup against the mounted database.

## Local verification and recovery rehearsal

Docker is the only prerequisite for the container check:

```bash
corepack pnpm --filter @irudd-le/mailbox test:container
```

The check builds a baseline from the fixed pre-revision-history mailbox commit
with that archived revision's Dockerfile, then builds the candidate from the
current checkout using the canonical root Dockerfile above. It initializes a
named volume, verifies both health and readiness, stops cleanly, reopens the
same volume, starts the candidate against it, and restores a stopped
pre-upgrade volume snapshot into the baseline image. Its containers and
volumes are removed on exit. It is intentionally separate from the normal unit
suite because it needs a Docker daemon. If that baseline commit is unavailable,
set `BASE_IMAGE` to an available prior image instead.

For a release rehearsal, point `BASE_IMAGE` to the currently deployed image
and `IMAGE_TAG` to the candidate image. This exercises the candidate's
migrations against a volume created by the previous release:

```bash
BASE_IMAGE=registry.example/mailbox:current \
IMAGE_TAG=irudd-le/mailbox:candidate \
corepack pnpm --filter @irudd-le/mailbox test:container
```

Production rollback is a data restore, not an attempt to run an older image
against a database that newer migrations may have changed:

1. Stop the mailbox cleanly and snapshot its persistent volume before an upgrade.
2. Start the candidate image against the original volume and wait for both probes.
3. If the candidate must be rolled back, stop it, replace the volume with the
   pre-upgrade snapshot, then start the selected safe image and recheck both probes.
4. Confirm a known channel and current revision with an authenticated `/v1/`
   request before admitting publishers.

The smoke check proves this sequence with `rev-1` before the upgrade and
`rev-2` after it; restoring the snapshot makes `rev-1` current again.

## Edge route and private administration

The initial public route is the API only. Configure the Cloudflare hostname
route so the `/v1/*` path is protected by an authenticated Access policy
(service credentials for agents and explicitly allowed human identities where
needed). Do not create a public route for `/admin`; block it at the edge even
though the mailbox can serve the page. Health and readiness probes belong on a
private platform/network path, not a public monitoring endpoint.

The first administration path is private host access: connect to the host by
SSH, or over a pre-existing Tailnet if one is already operated, and then reach
the mailbox through a loopback-bound port forward. Keep the admin page and
bootstrap/recovery credentials off public DNS and public routes. Designing or
rolling out the Tailnet itself, public administration, and any Cloudflare or
Piploy mutation are outside this contract and remain later work.
