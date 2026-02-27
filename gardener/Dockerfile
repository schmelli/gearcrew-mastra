FROM node:20-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/
RUN npx mastra build

FROM node:20-slim AS runner

WORKDIR /app

COPY --from=builder /app/.mastra/output ./.mastra/output

ENV NODE_ENV=production

USER node
EXPOSE 4111

CMD ["node", "--import=./.mastra/output/instrumentation.mjs", ".mastra/output/index.mjs"]
