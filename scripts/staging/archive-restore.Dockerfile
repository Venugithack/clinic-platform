# The image the local archive-restore rehearsal runs in.
#
# scripts/db-restore-archive.sh is bash and wants four things this machine does
# not have together: a PostgreSQL 17 server and client, `age`, `rclone`, and
# gzip. postgres:17 brings the first; the other two are one apt line. Building
# a small image once and reusing it keeps the rehearsal off the network on
# every run after the first, which matters because the whole point of the
# rehearsal is that it reaches nothing.
#
# Debian trixie carries age 1.2.x and rclone 1.60.x. Both are pinned to the
# distribution rather than to a version here on purpose: the script must work
# with whatever `apt-get install age rclone` gives a runner, which is exactly
# what .github/workflows/archive-restore.yml does.
FROM postgres:17

RUN apt-get update \
 && apt-get install -y --no-install-recommends age rclone ca-certificates \
 && rm -rf /var/lib/apt/lists/*
