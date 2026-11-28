FROM node:22-bookworm

# System + Python dependencies + fast code-search binaries (rg, fd)
RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  ripgrep \
  fd-find \
  python3 \
  python3-venv \
  python3-pip \
  && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
  && rm -rf /var/lib/apt/lists/*

# GitHub CLI (ready for local -> GitHub switchover)
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

# Install Codex CLI, Claude Code CLI, and ast-grep (structural AST search/refactor) globally
RUN npm install -g @openai/codex @anthropic-ai/claude-code @ast-grep/cli

# Install fast adversarial security & SAST binaries (gitleaks + opengrep)
RUN curl -fsSL https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz \
  | tar -xz -C /usr/local/bin gitleaks \
  && curl -fsSL https://github.com/opengrep/opengrep/releases/download/v2.1.0/opengrep_linux_x86 \
     -o /usr/local/bin/opengrep \
  && chmod +x /usr/local/bin/gitleaks /usr/local/bin/opengrep

# Pre-bake Python dev toolchain into /opt/venv so containers start in <1s without per-run pip installs
RUN python3 -m venv /opt/venv \
  && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
  && /opt/venv/bin/pip install --no-cache-dir \
       "ruff>=0.9.0" \
       "pyright>=1.1.390" \
       "pytest>=8.3.0" \
       "pytest-cov>=6.0.0" \
       "pytest-testmon>=2.1" \
       "pytest-xdist>=3.6" \
       "diff-cover>=9.2" \
       "hypothesis>=6.120.0" \
       "import-linter>=2.1" \
       "vulture>=2.14"

ENV PATH="/opt/venv/bin:$PATH"
ENV PYTHONPATH="/home/agent/workspace/src"
ENV MUTATION_WORKERS="2"

# Ensure both login shells (`bash -lc`) and non-login shells find /opt/venv tools
RUN for bin in python python3 pip ruff pyright pytest lint-imports vulture diff-cover; do \
      ln -sf "/opt/venv/bin/$bin" "/usr/local/bin/$bin"; \
    done \
  && echo 'export PATH="/opt/venv/bin:$PATH"' > /etc/profile.d/opt-venv.sh

# Build-args for UID/GID alignment (sandcastle docker build-image auto-passes host UID/GID on WSL2/Linux)
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Lock /opt/venv owned by root and strictly read-only so agents can execute referees, NEVER tamper with them
RUN groupmod -o -g $AGENT_GID node \
  && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node \
  && chown -R root:root /opt/venv \
  && chmod -R a-w /opt/venv

USER ${AGENT_UID}:${AGENT_GID}
WORKDIR /home/agent

# Prevent git "dubious ownership" errors on Windows/WSL2 bind-mounted worktrees
RUN git config --global --add safe.directory '*'

# Sandcastle bind-mounts the git worktree at /home/agent/workspace
ENTRYPOINT ["sleep", "infinity"]
