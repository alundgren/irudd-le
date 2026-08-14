# Mailbox

The mailbox is the durable, authenticated HTTP authority for channels, overlay
target registrations, revisions, and revision assets. It stores all service
state in the SQLite database named by `MAILBOX_DATABASE_PATH`.

## Run locally

```bash
MAILBOX_BEARER_TOKEN=replace-me \
MAILBOX_DATABASE_PATH=./mailbox.sqlite \
corepack pnpm --filter @irudd-le/mailbox build && \
node apps/mailbox/build/index.js
```

`GET /health` and `GET /ready` are unauthenticated probes. Every `/v1/`
endpoint requires `Authorization: Bearer <MAILBOX_BEARER_TOKEN>` and returns
structured JSON errors with `protocolVersion`, `code`, and `message`.

## Version 1 endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/channels` | Create a named channel, including when its target is offline. |
| `GET` | `/v1/channels/:channel` | Read a channel. |
| `POST` | `/v1/channels/:channel/targets` | Register or replace the channel's target profile. |
| `POST` | `/v1/channels/:channel/revisions` | Atomically store and activate HTML plus base64-encoded assets. |
| `GET` | `/v1/channels/:channel/revisions/current` | Fetch the active revision. |
| `GET` | `/v1/channels/:channel/revisions/history` | Fetch revision metadata, newest first. |
| `GET` | `/v1/assets/:asset` | Read immutable binary asset bytes. |

Mutation bodies include `protocolVersion: 1`. An unsupported version receives a
`400 unsupported_protocol_version` response. JSON request bodies are limited to
1 MiB. Publication writes use one SQLite transaction: failed inserts leave the
previous active revision untouched.

## Container

Build and run with a persistent volume:

```bash
docker build -f apps/mailbox/Dockerfile -t irudd-mailbox .
docker run --rm -p 3000:3000 \
  -e MAILBOX_BEARER_TOKEN=replace-me \
  -v mailbox-data:/var/lib/mailbox \
  irudd-mailbox
```
