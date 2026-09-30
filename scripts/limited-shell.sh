#!/usr/bin/env bash
set -euo pipefail
if [[ $# -lt 3 || ! "$2" =~ ^[1-9][0-9]*$ ]]; then
  echo 'Usage: limited-shell.sh SHARED_LOCK JOBS COMMAND [ARGS...]' >&2
  exit 2
fi
lock_path=$1
build_jobs=$2
shift 2
export CMAKE_BUILD_PARALLEL_LEVEL=$build_jobs CARGO_BUILD_JOBS=$build_jobs GOMAXPROCS=$build_jobs
export MAKEFLAGS="-j$build_jobs" GOFLAGS="${GOFLAGS:+$GOFLAGS }-p=$build_jobs"
# ponytail: one shared shell slot; add slots only after measuring host build capacity.
# All shell commands queue, so aliases and scripts cannot bypass a command-name classifier.
exec flock --exclusive --no-fork "$lock_path" "$@"
