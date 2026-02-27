FROM node:20-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

FROM node:20-slim AS runner

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
ENV DEPLOY_TARGET=cloudrun

USER node
EXPOSE 4111

CMD ["node", "dist/index.js"]
