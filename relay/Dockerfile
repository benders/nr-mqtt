FROM node:20-alpine

# Create non-root user
RUN addgroup -S relay && adduser -S relay -G relay

WORKDIR /app

# Copy package files and install production dependencies
COPY package.json package-lock.json* ./
RUN npm ci --only=production

# Copy application source
COPY index.js ./

# Switch to non-root user
USER relay

CMD ["node", "index.js"]
