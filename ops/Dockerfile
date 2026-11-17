# Imagem do Concilia. Fase de build compila API e web; fase final roda só o resultado.
# Uso: docker build -f ops/Dockerfile -t concilia .

FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:22-slim
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production WEB_DIST_DIR=/app/apps/web/dist MIGRATIONS_DIR=/app/apps/api/migrations
USER node
EXPOSE 3000
CMD ["node","apps/api/dist/main.js"]
