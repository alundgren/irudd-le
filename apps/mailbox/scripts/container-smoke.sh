#!/usr/bin/env bash
#
# Local smoke test for the mailbox's container recovery contract. It initializes
# a volume, reopens it, upgrades the serving image, and restores a pre-upgrade
# volume snapshot. It is deliberately not part of `pnpm test`, so the normal
# suite remains runnable without a Docker daemon.
#
#   corepack pnpm --filter @irudd-le/mailbox test:container
#
# By default the baseline image is built from the fixed pre-revision-history
# release commit, so the upgrade crosses persisted schema generations. For a
# release rehearsal, provide the previously published image as BASE_IMAGE. The
# upgrade image is built from this checkout.
#
#   BASE_IMAGE=ghcr.io/example/mailbox:previous \
#   IMAGE_TAG=irudd-le/mailbox:candidate \
#   bash apps/mailbox/scripts/container-smoke.sh
#
# Exits non-zero on any failure. Removes only its named containers, volumes,
# and the image built by this invocation.
set -euo pipefail

IMAGE_TAG="${IMAGE_TAG:-irudd-le/mailbox:smoke}"
VOLUME_NAME="${VOLUME_NAME:-mailbox-smoke-volume}"
SNAPSHOT_VOLUME_NAME="${SNAPSHOT_VOLUME_NAME:-${VOLUME_NAME}-pre-upgrade}"
HOST_PORT_FIRST="${HOST_PORT_FIRST:-18091}"
HOST_PORT_SECOND="${HOST_PORT_SECOND:-18092}"
HOST_PORT_UPGRADE="${HOST_PORT_UPGRADE:-18093}"
HOST_PORT_ROLLBACK="${HOST_PORT_ROLLBACK:-18094}"
CONTAINER_PORT="${CONTAINER_PORT:-8080}"
ADMIN_TOKEN="${ADMIN_TOKEN:-smoke-admin-secret}"
# c5ce423 introduced scoped credentials but predates revision-history and
# current-revision migrations. Keep this pinned until the oldest supported
# upgrade baseline intentionally changes.
BASE_REF="${BASE_REF:-c5ce423f3e63b0e098dae4e1d25f5adc78060ace}"
UPGRADE_IMAGE="${IMAGE_TAG}"
BASE_IMAGE="${BASE_IMAGE:-}"
BUILT_IMAGE=false
BUILT_BASE_IMAGE=false

cleanup() {
  docker rm -f mb-1 mb-2 mb-3 mb-4 >/dev/null 2>&1 || true
  docker volume rm "${VOLUME_NAME}" >/dev/null 2>&1 || true
  docker volume rm "${SNAPSHOT_VOLUME_NAME}" >/dev/null 2>&1 || true
  if [ "${BUILT_IMAGE}" = true ]; then
    docker image rm "${UPGRADE_IMAGE}" >/dev/null 2>&1 || true
  fi
  if [ "${BUILT_BASE_IMAGE}" = true ]; then
    docker image rm "${BASE_IMAGE}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

wait_for() { # <container-name> <host-port>
  local container="${1}"
  local port="${2}"
  for _ in $(seq 1 40); do
    if curl -sf "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1 \
      && curl -sf "http://127.0.0.1:${port}/readyz" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  echo "mailbox on port ${port} never became ready" >&2
  docker logs "${container}" || true
  exit 1
}

stop_cleanly() { # <container-name>
  local container="${1}"
  docker stop "${container}" >/dev/null
  local exit_code
  exit_code=$(docker inspect --format '{{.State.ExitCode}}' "${container}")
  if [ "${exit_code}" != 0 ]; then
    echo "${container} did not shut down cleanly (exit ${exit_code})" >&2
    docker logs "${container}" || true
    exit 1
  fi
  # A stopped container still holds a volume reference, so release it before
  # the rollback step replaces the named volume.
  docker rm "${container}" >/dev/null
}

copy_volume() { # <source-volume> <target-volume>
  docker run --rm \
    -v "${1}:/source:ro" \
    -v "${2}:/target" \
    node:24-slim sh -ceu 'cp -a /source/. /target/'
}

current_revision() { # <host-port>
  curl -sf -H "authorization: Bearer ${ADMIN_TOKEN}" \
    "http://127.0.0.1:${1}/v1/channels/main/revisions/current"
}

assert_current_revision() { # <host-port> <revision-id>
  local revision
  revision=$(current_revision "${1}")
  case "${revision}" in
    *"\"id\":\"${2}\""*) ;;
    *) echo "expected current revision ${2}, got: ${revision}" >&2; exit 1 ;;
  esac
}

cd "$(dirname "${BASH_SOURCE[0]}")/../../.."

if [ -z "${BASE_IMAGE}" ]; then
  BASE_IMAGE="${IMAGE_TAG}-base"
  echo ">> building baseline ${BASE_IMAGE} from ${BASE_REF}"
  git archive --format=tar "${BASE_REF}" | docker build -t "${BASE_IMAGE}" -f apps/mailbox/Dockerfile -
  BUILT_BASE_IMAGE=true
elif ! docker image inspect "${BASE_IMAGE}" >/dev/null 2>&1; then
  echo ">> pulling baseline ${BASE_IMAGE}"
  docker pull "${BASE_IMAGE}" >/dev/null
fi

echo ">> building ${UPGRADE_IMAGE}"
docker build -t "${UPGRADE_IMAGE}" -f apps/mailbox/Dockerfile .
BUILT_IMAGE=true

if [ "$(docker image inspect --format '{{.Id}}' "${BASE_IMAGE}")" = "$(docker image inspect --format '{{.Id}}' "${UPGRADE_IMAGE}")" ]; then
  echo "baseline and upgrade images must differ; choose a different BASE_IMAGE or BASE_REF" >&2
  exit 1
fi

echo ">> initializing volume ${VOLUME_NAME}"
docker volume create "${VOLUME_NAME}" >/dev/null

echo ">> first run: publish a channel + revision"
docker run -d --name mb-1 -p "${HOST_PORT_FIRST}:${CONTAINER_PORT}" \
  -e MAILBOX_ADMIN_BOOTSTRAP_TOKEN="${ADMIN_TOKEN}" \
  -e MAILBOX_LISTEN_PORT="${CONTAINER_PORT}" \
  -v "${VOLUME_NAME}:/var/lib/mailbox" \
  "${BASE_IMAGE}" >/dev/null
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
  -d '{"protocolVersion":1,"id":"rev-1","channel":"main","profileVersion":1,"html":"<p>first</p>","assetIds":[],"title":"Smoke","description":null}' \
  "http://127.0.0.1:${HOST_PORT_FIRST}/v1/channels/main/revisions/current" >/dev/null

stop_cleanly mb-1

echo ">> snapshotting the stopped pre-upgrade volume"
docker volume create "${SNAPSHOT_VOLUME_NAME}" >/dev/null
copy_volume "${VOLUME_NAME}" "${SNAPSHOT_VOLUME_NAME}"

echo ">> second run: reopen the same volume and assert persistence"
docker run -d --name mb-2 -p "${HOST_PORT_SECOND}:${CONTAINER_PORT}" \
  -e MAILBOX_ADMIN_BOOTSTRAP_TOKEN="${ADMIN_TOKEN}" \
  -e MAILBOX_LISTEN_PORT="${CONTAINER_PORT}" \
  -v "${VOLUME_NAME}:/var/lib/mailbox" \
  "${BASE_IMAGE}" >/dev/null
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

stop_cleanly mb-2

echo ">> upgrade: start ${UPGRADE_IMAGE} against the persisted volume"
docker run -d --name mb-3 -p "${HOST_PORT_UPGRADE}:${CONTAINER_PORT}" \
  -e MAILBOX_ADMIN_BOOTSTRAP_TOKEN="${ADMIN_TOKEN}" \
  -e MAILBOX_LISTEN_PORT="${CONTAINER_PORT}" \
  -v "${VOLUME_NAME}:/var/lib/mailbox" \
  "${UPGRADE_IMAGE}" >/dev/null
wait_for mb-3 "${HOST_PORT_UPGRADE}"
assert_current_revision "${HOST_PORT_UPGRADE}" rev-1

curl -sf -X PUT -H 'content-type: application/json' -H "authorization: Bearer ${publisher_token}" \
  -d '{"protocolVersion":1,"id":"rev-2","channel":"main","profileVersion":1,"html":"<p>after upgrade</p>","assetIds":[],"title":"Smoke","description":null}' \
  "http://127.0.0.1:${HOST_PORT_UPGRADE}/v1/channels/main/revisions/current" >/dev/null
assert_current_revision "${HOST_PORT_UPGRADE}" rev-2
stop_cleanly mb-3

echo ">> rollback: restore the pre-upgrade volume snapshot"
docker volume rm "${VOLUME_NAME}" >/dev/null
docker volume create "${VOLUME_NAME}" >/dev/null
copy_volume "${SNAPSHOT_VOLUME_NAME}" "${VOLUME_NAME}"

docker run -d --name mb-4 -p "${HOST_PORT_ROLLBACK}:${CONTAINER_PORT}" \
  -e MAILBOX_ADMIN_BOOTSTRAP_TOKEN="${ADMIN_TOKEN}" \
  -e MAILBOX_LISTEN_PORT="${CONTAINER_PORT}" \
  -v "${VOLUME_NAME}:/var/lib/mailbox" \
  "${BASE_IMAGE}" >/dev/null
wait_for mb-4 "${HOST_PORT_ROLLBACK}"
assert_current_revision "${HOST_PORT_ROLLBACK}" rev-1
stop_cleanly mb-4

echo "✓ container initialize, reopen, readiness, upgrade, and rollback checks passed"
