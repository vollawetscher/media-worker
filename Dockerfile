FROM node:20-slim

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source files
COPY tsconfig.json ./
COPY src ./src

# Build the TypeScript project
RUN npm run build

# Remove devDependencies to reduce image size
RUN npm prune --production

# Set production environment
ENV NODE_ENV=production

# Create non-root user for security
RUN groupadd -r nodejs && useradd -r -g nodejs nodejs

# Change ownership of app files
RUN chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); })"

# Set Node.js memory limit to 90% of container limit (896MB for 1GB container)
# This prevents OOM kills and allows Node.js to GC before hitting container limit
CMD ["node", "--max-old-space-size=896", "dist/index.js"]
