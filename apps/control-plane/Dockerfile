FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/control-plane/package.json ./apps/control-plane/

RUN npm install

COPY packages/shared/ ./packages/shared/
COPY apps/control-plane/ ./apps/control-plane/

RUN npm run --workspace=@djr/shared build
RUN npm run --workspace=@djr/control-plane build

FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4000

COPY package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/control-plane/package.json ./apps/control-plane/

RUN npm install --omit=dev

COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/apps/control-plane/dist ./apps/control-plane/dist

EXPOSE 4000

CMD ["node", "apps/control-plane/dist/index.js"]
