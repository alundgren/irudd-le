#!/usr/bin/env bash
#
# Manual smoke test for the "local container can initialize and reopen the same
# database volume" criterion of issue #34. Not wired into `pnpm test`; run from
# a host with Docker available.
#
#   bash apps/mailbox/scripts/container-smoke.sh
#
# Exits non-zero on any failure. Removes its own volume and intermediate image.
set -euo pipefail

IMAGE_TAG="${IMAGE_TAG:-irudd-le/mailbox:smoke}"
VOLUME_NAME="${VOLUME_NAME:-mailbox-smoke-volume}"
HOST_PORT_FIRST="${HOST_PORT_FIRST:-18091}"
HOST_PORT_SECOND="${HOST_PORT_SECOND:-18092}"
ADMIN_TOKEN="${ADMIN_TOKEN:-smoke-admin-secret}"

cleanup() {
  docker rm -f mb-1 mb-2 >/dev/null 2>&1 || true
  docker volume rm "${VOLUME_NAME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_for() { # <container-name> <port>
  local container="${1}"
  local port="${2}"
  for _ in $(seq 1 40); do
    if curl -sf "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  echo "mailbox on port ${port} never became ready" >&2
  docker logs "${container}" || true
  exit 1
}

cd "$(dirname "${BASH_SOURCE[0]}")/../../.."

echo ">> building ${IMAGE_TAG}"
docker build -t "${IMAGE_TAG}" -f apps/mailbox/Dockerfile .

echo ">> initializing volume ${VOLUME_NAME}"
docker volume create "${VOLUME_NAME}" >/dev/null

echo ">> first run: publish a channel + revision"
docker run -d --rm --name mb-1 -p "${HOST_PORT_FIRST}:8080" \
  -e MAILBOX_ADMIN_BOOTSTRAP_TOKEN="${ADMIN_TOKEN}" \
  -v "${VOLUME_NAME}:/var/lib/mailbox" \
  "${IMAGE_TAG}" >/dev/null
wait_for mb-1 "${HOST_PORT_FIRST}"

curl -sf -X POST -H 'content-type: application/json' -H "authorization: Bearer ${ADMIN_TOKEN}" \
  -d '{"protocolVersion":1,"id":"main","name":"Main"}' \
  "http://127.0.0.1:${HOST_PORT_FIRST}/v1/channels" >/dev/null

# Publish through a scoped publisher token, the same way a real client would,
# rather than the admin credential, so this exercises the deployed scope model.
publisher_response=$(curl -sf -X POST -H 'content-type: application/json' -H "authorization: Bearer ${ADMIN_TOKEN}" \
  -d '{"protocolVersion":1,"kind":"publisher","channel":"main","label":"smoke"}' \
  "http://127.0.0.1:${HOST_PORT_FIRST}/v1/admin/tokens")
publisher_token=$(printf '%s' "${publisher_response}" | sed -n 's/.*"secret":"\([^"]*\)".*/\1/p')
if [ -z "${publisher_token}" ]; then
  echo "failed to mint a publisher token: ${publisher_response}" >&2
  exit 1
fi

curl -sf -X PUT -H 'content-type: application/json' -H "authorization: Bearer ${publisher_token}" \
  -d '{"protocolVersion":1,"id":"rev-1","channel":"main","profileVersion":1,"html":"<p>first</p>","assetIds":[]}' \
  "http://127.0.0.1:${HOST_PORT_FIRST}/v1/channels/main/revisions/current" >/dev/null

docker stop mb-1 >/dev/null

echo ">> second run: reopen the same volume and assert persistence"
docker run -d --rm --name mb-2 -p "${HOST_PORT_SECOND}:8080" \
  -e MAILBOX_ADMIN_BOOTSTRAP_TOKEN="${ADMIN_TOKEN}" \
  -v "${VOLUME_NAME}:/var/lib/mailbox" \
  "${IMAGE_TAG}" >/dev/null
wait_for mb-2 "${HOST_PORT_SECOND}"

channel=$(curl -sf -H "authorization: Bearer ${ADMIN_TOKEN}" "http://127.0.0.1:${HOST_PORT_SECOND}/v1/channels/main")
revision=$(curl -sf -H "authorization: Bearer ${ADMIN_TOKEN}" "http://127.0.0.1:${HOST_PORT_SECOND}/v1/channels/main/revisions/current")

case "${channel}" in
  *'"id":"main"'*) ;;
  *) echo "channel mismatch: ${channel}"; exit 1 ;;
esac
case "${revision}" in
  *'"id":"rev-1"'*) ;;
  *) echo "revision mismatch: ${revision}"; exit 1 ;;
esac

docker stop mb-2 >/dev/null
echo "✓ container initialized and reopened the same database volume"