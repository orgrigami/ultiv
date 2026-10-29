# The `bash` tool's microVM image (see packages/ext/src/shell/sandbox-backend.ts).
# microsandbox cannot pull local tags from a registry, so build, save, and load
# the archive into the runtime's image store:
#
#   docker build -t ultiv-sandbox:latest packages/ext/sandbox
#   docker save ultiv-sandbox:latest -o var/ultiv-sandbox.tar
#   vp -C packages/ext exec msb load -i var/ultiv-sandbox.tar -t ultiv-sandbox:latest
#
# Baseline: node 24, python 3 + pip, jq, tar, curl, git, ca-certificates on
# Debian slim (apt-get for everything else). ULTIV_SANDBOX_IMAGE points the
# backend at any other OCI reference instead.
FROM node:24-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    jq \
    python3 \
    python3-pip \
  && rm -rf /var/lib/apt/lists/*

# Agent convenience: plain `pip install` works without the PEP 668
# externally-managed-environment guard Debian ships.
ENV PIP_BREAK_SYSTEM_PACKAGES=1

WORKDIR /home
