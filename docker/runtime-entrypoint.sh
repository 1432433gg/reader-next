#!/bin/sh
set -eu
if [ "$#" -eq 0 ]; then set -- reader; fi
case "$1" in
    reader)
        shift
        exec /app/reader-next "$@"
        ;;
    webview)
        shift
        exec node /app/remote-webview/index.js "$@"
        ;;
    egress)
        shift
        exec /bin/sh /app/egress/start.sh "$@"
        ;;
    *) exec "$@" ;;
esac
