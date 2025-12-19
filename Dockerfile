FROM node:20-alpine

WORKDIR /app

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
