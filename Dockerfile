FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY src ./src
COPY tsup.config.ts tsconfig.json ./
RUN npm run build

FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=optional
COPY --from=builder /app/dist ./dist

EXPOSE 3100

CMD ["node", "dist/bin/kaia-mcp.js", "--transport", "http", "--port", "3100"]
