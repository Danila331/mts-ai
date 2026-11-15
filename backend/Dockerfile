# Образ Go-API. Сборка — отдельной стадией: в образ уезжает один
# бинарник без компилятора и исходников.
FROM golang:1.26-alpine AS build

WORKDIR /src

# Зависимости отдельным слоем: они меняются несравнимо реже кода, и без
# этого каждая правка тянет полную загрузку модулей.
COPY go.mod go.sum ./
RUN go mod download

COPY . .

# CGO выключен: бинарник должен запускаться в образе без libc сборки.
# Миграции вшиты в бинарник (migrations/migrations.go), копировать их
# рядом не нужно.
# Версия попадает в каждую строку журнала (поле version). Без аргумента
# служба на Railway берёт её из RAILWAY_GIT_COMMIT_SHA.
ARG VERSION=dev
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" -o /out/api ./cmd/api

FROM alpine:3.22

# Сертификаты нужны для похода в API модели по HTTPS: без них TLS не
# проверится, и резюме заявок будет падать невнятной ошибкой соединения.
RUN apk add --no-cache ca-certificates tzdata \
 && adduser -D -u 65532 energytool

WORKDIR /app
COPY --from=build /out/api /app/api

USER energytool
# 8080 — API, 9091 — /metrics (только приватная сеть).
EXPOSE 8080 9091

# Конфига в образе нет намеренно: настройки — только окружением, ровно
# как на хостинге. Флаг указывает на несуществующий файл.
ENTRYPOINT ["/app/api", "-config", "/app/no-config.yaml"]
