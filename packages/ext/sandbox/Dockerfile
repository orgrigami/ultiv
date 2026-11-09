# The `bash` tool's microVM image (see packages/ext/src/shell/sandbox-backend.ts).
# microsandbox cannot pull local tags from a registry, so build, save, and load
# the archive into the runtime's image store:
#
#   docker build -t ultiv-sandbox:latest packages/ext/sandbox
#   docker save ultiv-sandbox:latest -o var/ultiv-sandbox.tar
#   vp -C packages/ext exec msb load -i var/ultiv-sandbox.tar -t ultiv-sandbox:latest
#
# Baseline: node 26, python 3 + pip, jq, tar, curl, git, ca-certificates on
# Debian slim (apt-get for everything else). SPRIESSEN_SANDBOX_IMAGE points the
# backend at any other OCI reference instead.
#
# Chromium (phase 4 slice 9, the read-only `browser_open` tool) rides in every
# VM so a browser call never apt-installs at call time. Cost (measured on this
# machine, 1 Nov 2026): the image grows from 579 MB to 1.56 GB on disk —
# roughly +1 GB per VM disk; idle RAM cost none until it runs. A fresh
# machine — or an existing one after this change — must rebuild the image
# once (the running VMs keep the old image until they are recreated):
#
#   docker build -t ultiv-sandbox:latest packages/ext/sandbox
#   docker save ultiv-sandbox:latest -o var/ultiv-sandbox.tar
#   vp -C packages/ext exec msb load -i var/ultiv-sandbox.tar -t ultiv-sandbox:latest
#
# fonts-liberation keeps rendered pages (screenshots) from falling back to
# bitmap fonts; a few MB.
FROM node:26-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    acl \
    ca-certificates \
    chromium \
    fonts-liberation \
    curl \
    git \
    jq \
    python3 \
    python3-pip \
  && rm -rf /var/lib/apt/lists/*

# The browser broker's own system user (packages/ext/src/browser/vm): ONE
# chromium per VM runs as it, over a pipe (no debug port), with its socket in
# a 0700 folder only root reaches — a bot's bash can reach neither. The
# broker itself is written into /opt/spriessen-browser/<version> at first use
# (so a fixed broker never waits for an image rebuild); the user is created
# here, and the first start creates it too on an older image.
RUN useradd --system --no-create-home --home-dir /nonexistent \
    --shell /usr/sbin/nologin spbrowser \
  && mkdir -p /opt/spriessen-browser /run/spriessen-browser /var/lib/spriessen-browser \
  && chown spbrowser:spbrowser /run/spriessen-browser /var/lib/spriessen-browser \
  && chmod 700 /run/spriessen-browser /var/lib/spriessen-browser

# Agent convenience: plain `pip install` works without the PEP 668
# externally-managed-environment guard Debian ships.
ENV PIP_BREAK_SYSTEM_PACKAGES=1

WORKDIR /home
