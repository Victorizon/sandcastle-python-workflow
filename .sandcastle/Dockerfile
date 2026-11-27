FROM node:22-bookworm

# System + Python dependencies
RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  python3 \
  python3-venv \
  python3-pip \
  && rm -rf /var/lib/apt/lists/*

# GitHub CLI (ready for local -> GitHub switchover)
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

# Install Codex CLI globally so `agent` user can run `codex exec`
RUN npm install -g @openai/codex

# Pre-bake Python dev toolchain into /opt/venv so containers start in <1s without per-run pip installs
RUN python3 -m venv /opt/venv \
  && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
  && /opt/venv/bin/pip install --no-cache-dir \
       "ruff>=0.9.0" \
       "pyright>=1.1.390" \
       "pytest>=8.3.0" \
       "pytest-cov>=6.0.0" \
       "import-linter>=2.1"

ENV PATH="/opt/venv/bin:$PATH"
ENV PYTHONPATH="/home/agent/workspace/src"

# Ensure both login shells (`bash -lc`) and non-login shells find /opt/venv tools
RUN for bin in python python3 pip ruff pyright pytest lint-imports; do \
      ln -sf "/opt/venv/bin/$bin" "/usr/local/bin/$bin"; \
    done \
  && echo 'export PATH="/opt/venv/bin:$PATH"' > /etc/profile.d/opt-venv.sh

# Build-args for UID/GID alignment (sandcastle docker build-image auto-passes host UID/GID on WSL2/Linux)
ARG AGENT_UID=1000
ARG AGENT_GID=1000

RUN groupmod -o -g $AGENT_GID node \
  && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node \
  && chown -R ${AGENT_UID}:${AGENT_GID} /opt/venv

USER ${AGENT_UID}:${AGENT_GID}
WORKDIR /home/agent

# Prevent git "dubious ownership" errors on Windows/WSL2 bind-mounted worktrees
RUN git config --global --add safe.directory '*'

# Sandcastle bind-mounts the git worktree at /home/agent/workspace
ENTRYPOINT ["sleep", "infinity"]
