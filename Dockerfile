FROM node:20-alpine AS base
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

# Non-root user - no reason to run this as root inside the container
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 8080
ENV PORT=8080

# No secrets, API keys, or tokens are ever baked into this image.
# Anything the app needs at runtime comes from environment variables /
# a secrets manager (Vault, AWS Secrets Manager), injected by ECS - never here.

CMD ["node", "src/index.js"]
