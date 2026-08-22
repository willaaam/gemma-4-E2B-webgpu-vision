# Node 22 LTS dev image (has npm, git, vscode remote tooling)
FROM mcr.microsoft.com/devcontainers/javascript-node:22

# This app is served with `python3 -m http.server 4173` for local dev,
# so make sure python3 is present inside the container.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*
