# syntax=docker/dockerfile:1
# The dashboard as a standalone Next.js server on port 3000.
#
#   docker build --build-arg BACKEND_URL=http://backend:3000 -t ai-ops-dashboard .
#
# BACKEND_URL is where /api/* is proxied to. Next bakes it in at build time,
# so changing it means rebuilding. (Behind the deploy setup's Caddy, /api/* goes
# straight to the backend and this proxy is only a fallback.)
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG BACKEND_URL=http://backend:3000
ENV BACKEND_URL=$BACKEND_URL \
    NEXT_OUTPUT=standalone \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
USER node
EXPOSE 3000
CMD ["node", "server.js"]
