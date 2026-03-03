#!/bin/bash
# Usage: ./scripts/add-device.sh <username> <password>
# Adds or updates a device credential in the mosquitto password file.
#
# The mosquitto container must be running before calling this script.
# Credentials are written to mosquitto/config/passwd which is mounted
# read-only into the container; mosquitto reloads it on SIGHUP.
#
# Example:
#   ./scripts/add-device.sh geeforce-device MySecretPass1
#   ./scripts/add-device.sh nr-relay        MySecretPass2

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PASSWD_FILE="$PROJECT_DIR/mosquitto/config/passwd"
CONTAINER_NAME="mosquitto"

usage() {
  echo "Usage: $0 <username> <password>" >&2
  exit 1
}

if [[ $# -ne 2 ]]; then
  usage
fi

USERNAME="$1"
PASSWORD="$2"

if [[ -z "$USERNAME" || -z "$PASSWORD" ]]; then
  usage
fi

# Ensure the passwd file exists on the host so the volume mount works
touch "$PASSWD_FILE"

# Always write via a temporary container so the host file is writable regardless
# of the :ro volume mount used by the running mosquitto container.
echo "INFO: Writing credential for '$USERNAME'..."
docker run --rm \
  -v "$PASSWD_FILE:/mosquitto/config/passwd" \
  eclipse-mosquitto:2.0 \
  mosquitto_passwd -b /mosquitto/config/passwd "$USERNAME" "$PASSWORD"

# If mosquitto is running, signal it to reload the password file live.
if docker compose -f "$PROJECT_DIR/docker-compose.yml" ps --services --filter "status=running" 2>/dev/null | grep -q "^mosquitto$"; then
  echo "INFO: Sending SIGHUP to mosquitto to reload credentials..."
  docker compose -f "$PROJECT_DIR/docker-compose.yml" exec mosquitto \
    sh -c 'kill -HUP $(pidof mosquitto)' 2>/dev/null || true
fi

echo "OK: credential set for user '$USERNAME'"
