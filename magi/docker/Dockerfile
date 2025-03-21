FROM node:23-slim

# Update npm
RUN npm install -g npm

# Install node dependencies
RUN --mount=type=cache,target=/root/.npm \
    --mount=type=bind,source=magi/package.json,target=package.json \
    --mount=type=bind,source=magi/package-lock.json,target=package-lock.json \
    npm ci

# Install claude code
RUN npm install -g @anthropic-ai/claude-code

# Install Playwright dependencies in root
RUN npx playwright install-deps chromium

# Create a non-root user
RUN useradd -m magi_user

# Create a non-root user and ensure permissions
RUN mkdir -p /home/magi_user/.claude && \
    touch /home/magi_user/.claude/config.json && \
    touch /home/magi_user/.claude.json && \
    chmod 777 /home/magi_user/.claude.json && \
    chmod -R 777 /home/magi_user/.claude && \
    chown -R magi_user:magi_user /home/magi_user/
RUN mkdir -p /app && chown -R magi_user:magi_user /app

# Create output directories with proper permissions
RUN mkdir -p /magi_output && chmod 777 /magi_output
RUN mkdir -p /claude_shared && chmod 777 /claude_shared

# Switch to non-root user
USER magi_user

# No COPY command for magi folder - we'll mount it as a volume instead
WORKDIR /app

# Install browser for the non-root user and create required directories
RUN mkdir -p /home/magi_user/.cache && \
    chmod -R 777 /home/magi_user/.cache

# Install Playwright chromium for magi_user
RUN npx playwright install --only-shell chromium
