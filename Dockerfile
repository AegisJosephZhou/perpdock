FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig*.json vite.config.ts vitest.config.ts ./
COPY shared ./shared
COPY server ./server
COPY client ./client
COPY tests ./tests
COPY scripts ./scripts
RUN npm run build && npm test && npm run test:deployment

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_DIR=/app/data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY scripts/backup.mjs ./scripts/backup.mjs
COPY scripts/check-public-env.mjs ./scripts/check-public-env.mjs
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/server/index.js"]
