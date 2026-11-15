# Образ стенда и виджета (Next.js). Три стадии: зависимости, сборка и
# запуск. В последний образ уезжает только standalone-сервер Next
# (output: "standalone" в next.config.ts) со статикой — без исходников,
# devDependencies и кеша npm.
#
# Та же версия Node, что в CI (ci.yml, job TypeScript).
FROM node:22-alpine AS deps

WORKDIR /app

# Зависимости отдельным слоем: lock-файл меняется несравнимо реже кода.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22-alpine AS build

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# prebuild собирает public/widget.js (esbuild), затем next build.
RUN npm run build

FROM node:22-alpine AS run

WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000

# Пользователь node (uid 1000) уже есть в образе: root серверу Next не
# нужен, а файлы приложения ему принадлежать не должны — только читаться.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

USER node
EXPOSE 3000

# Проверяется сам сервер Next, а не API за ним: /widget.js — статика,
# она отвечает и тогда, когда api ещё поднимается.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO /dev/null http://127.0.0.1:3000/widget.js || exit 1

# Адрес и токен Go-API — только окружением (EB_API_URL, EB_API_TOKEN):
# их читает прокси /api/* при каждом запросе, в сборку они не попадают.
CMD ["node", "server.js"]
