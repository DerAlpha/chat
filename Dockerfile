# syntax=docker/dockerfile:1
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# Nur die Laufzeit-Abhängigkeiten - Playwright & Co. gehören nicht ins Image.
# Bewusst ohne Ausweg auf `npm install`: die Sperrdatei ist eine Zusage, und
# ein stiller Ausweg darauf baut im Zweifel etwas anderes als geprueft wurde.
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/data
WORKDIR /app

RUN apk add --no-cache tini \
 && mkdir -p /data \
 && chown -R node:node /data

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node public ./public
# Muss mit: server/ice.js holt sich makeCredentials() von hier. Ohne diesen
# Ordner bricht der Start mit "Cannot find module" ab - das Bild lief nicht.
COPY --chown=node:node turn ./turn

USER node
EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+(process.env.BASE_PATH||'')+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini fängt SIGTERM ab, damit der Server sauber herunterfährt.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/index.js"]
