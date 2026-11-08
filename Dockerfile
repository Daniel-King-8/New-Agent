FROM node:22-slim

WORKDIR /app

ENV NODE_ENV=production
ENV TZ=Asia/Shanghai

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /data && chown -R node:node /app /data

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "healthcheck.mjs"]

CMD ["node", "app.mjs"]
