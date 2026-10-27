# GPX Library — application image (no state inside: PostgreSQL + S3 hold the data).
# Built and run by docker-compose (service `app`); see docker-compose.yml.
FROM node:24.21.0-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    NO_OPEN=1
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# Everything the app writes outside the database and the store lives in the `appdata` volume
# (/app/data): backups, logs, OSM cache, settings (Wikiloc token), the IBP key and the _TEMP_ inbox.
RUN mkdir -p data TracksGps photos \
 && ln -s /app/data/osm-settings.json osm-settings.json \
 && ln -s /app/data/ibp.key ibp.key \
 && ln -s /app/data/_TEMP_ TracksGps/_TEMP_ \
 && chown -R node:node /app
USER node

EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/admin/version').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["sh", "-c", "mkdir -p data/_TEMP_ && exec node server.js"]
