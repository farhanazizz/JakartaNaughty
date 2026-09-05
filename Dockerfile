# ============================================================
# Dockerfile — Krea2 Edit Website Platform
# ============================================================
FROM node:20-alpine AS base

# Install dumb-init untuk proper signal handling (graceful shutdown)
RUN apk add --no-cache dumb-init libc6-compat

WORKDIR /app

# Set environment
ENV NODE_ENV=production
ENV PORT=3000

# Copy package files dan install production dependencies
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy seluruh source code dan assets frontend
COPY src/ ./src/
COPY public/ ./public/

# Buat folder uploads dan outputs
RUN mkdir -p uploads outputs

# Expose port
EXPOSE 3000

# Jalankan server dengan signal handling
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "src/server.js"]


