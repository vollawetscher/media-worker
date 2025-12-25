FROM node:20-slim

WORKDIR /app

# Install CA certificates for HTTPS requests
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

# Build the TypeScript project
RUN npm run build

# Remove devDependencies to reduce image size
RUN npm prune --production

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
