FROM node:22-slim AS builder
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY dist/ ./dist/

FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends libvips-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./
ENV NODE_ENV=production
EXPOSE 5000
CMD ["node", "dist/index.js"]
