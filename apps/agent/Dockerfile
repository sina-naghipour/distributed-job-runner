FROM node:20-alpine AS builder

WORKDIR /app

# Copy root manifest and workspace package manifests
COPY package.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/agent/package.json ./apps/agent/

# Install dependencies across workspaces
RUN npm install

# Copy source files
COPY packages/shared/ ./packages/shared/
COPY apps/agent/ ./apps/agent/

# Build shared library and agent
RUN npm run --workspace=@djr/shared build
RUN npm run --workspace=@djr/agent build

# Production runtime image
FROM node:20-alpine AS runner

WORKDIR /app

# Install Docker CLI in case needed for debugging inside the agent
RUN apk add --no-cache docker-cli

ENV NODE_ENV=production

COPY package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/agent/package.json ./apps/agent/

# Install production dependencies only
RUN npm install --omit=dev

COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/apps/agent/dist ./apps/agent/dist

# Run the agent entrypoint
CMD ["node", "apps/agent/dist/index.js"]
