#!/bin/sh
# Fix the volume's ownership, then drop privileges.
#
# A Railway volume (and a plain `docker run -v`) is mounted at RUN time, over whatever the
# image had at that path, and it arrives owned by root. The image's `chown node:node /data` is
# therefore undone by the mount, and the service -- which runs as `node`, because a process
# that executes strangers' instructions should not be root -- cannot write its state file:
#
#   EACCES: permission denied, open '/data/executor-state.json.1.tmp'
#
# Which is not fatal, and that is the trap: the service keeps running, keeps classifying and
# keeps executing, and silently loses its memory across restarts. It would have paid for
# attestations twice, for as long as nobody read the logs.
#
# So ownership is fixed here, where the mount is already in place, and only then does the
# service start as `node`.
set -e

if [ -d /data ]; then
  chown -R node:node /data 2>/dev/null || echo "warning: could not take ownership of /data; state will not persist"
fi

exec su-exec node "$@"
