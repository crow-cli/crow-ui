#!/usr/bin/env bash
# Launcher script that disables Electron sandbox.
# Ubuntu 24.04+ blocks unprivileged user namespaces via AppArmor,
# and SUID sandbox doesn't work in user-owned installs.
SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$SCRIPT_DIR/$SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd)"

exec "$SCRIPT_DIR/{{EXEC_NAME}}-bin" --no-sandbox "$@"
