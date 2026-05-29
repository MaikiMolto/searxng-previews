# Multi-stage build for SearXNG Preview Service

# Stage 1: Builder - Install dependencies and Playwright
FROM node:22-slim AS builder

# Install dependencies for Playwright
RUN apt-get update && apt-get install -y \
    libnss3 \
    libnspr4 \
    libdbus-1-3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libatspi2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --omit=dev

# Install Playwright Chromium
RUN npx playwright install chromium

# Stage 2: Runtime - Copy and run
FROM node:22-slim AS runtime

# Install runtime dependencies for Playwright
RUN apt-get update && apt-get install -y \
    libnss3 \
    libnspr4 \
    libdbus-1-3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libatspi2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -r appuser && useradd -r -g appuser -s /bin/false appuser

WORKDIR /app

# Copy node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy Playwright browsers from builder
COPY --from=builder /root/.cache/ms-playwright /home/appuser/.cache/ms-playwright
RUN chown -R appuser:appuser /home/appuser/.cache

# Copy source code
COPY --chown=appuser:appuser src/ ./src/
COPY --chown=appuser:appuser package.json ./

# Create cache directory
RUN mkdir -p cache && chown -R appuser:appuser cache

# Switch to non-root user
USER appuser

# Set Playwright browsers path
ENV PLAYWRIGHT_BROWSERS_PATH=/home/appuser/.cache/ms-playwright

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://localhost:3000/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Run the server
CMD ["node", "src/server.js"]
