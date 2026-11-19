#!/usr/bin/env bash
set -euo pipefail

ref=$1
event=$2
extra=${3:-}

if [[ $ref =~ ^refs/tags/v([0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
    version=${BASH_REMATCH[1]}
    printf '%s\n' "$version"
    if [[ $version == 1.2.1 ]]; then
        exit 0
    fi
    printf 'latest\n'
elif [[ $event != workflow_dispatch || $ref != refs/heads/* ]]; then
    echo "Unsupported Docker release ref: $ref" >&2
    exit 1
fi

if [[ $event == workflow_dispatch ]]; then
    if [[ -n $extra ]]; then
        if [[ ! $extra =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$ || $extra == latest || $extra =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
            echo "Invalid or reserved custom image tag: $extra" >&2
            exit 1
        fi
        printf '%s\n' "$extra"
    fi
    printf 'sha-%.7s\n' "${GITHUB_SHA:?}"
fi
