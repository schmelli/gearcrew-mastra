FROM node:20-slim AS base

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/

# Build
RUN npx tsc

# Run
ENV NODE_ENV=production
ENV DEPLOY_TARGET=cloudrun

EXPOSE 4111

CMD ["node", "dist/index.js"]
