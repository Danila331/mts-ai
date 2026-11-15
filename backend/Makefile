DSN ?= postgres://energytool:energytool@localhost:5433/energytool?sslmode=disable
CONFIG ?= configs/api-local.yaml

# Тот же .env, что у Python-ядра: ключ модели, токены. Переменные
# окружения перекрывают configs/api-local.yaml.
ENV_FILE := ../.env

.PHONY: up down db-up core api test test-db lint sqlc build

# Весь бэкенд в docker: база, ядро, API на :8787.
up:
	cd .. && docker compose up --build -d

down:
	cd .. && docker compose down

# Только база — для запуска api и ядра на хосте.
db-up:
	cd .. && docker compose up -d db

# Ядро на хосте: из виртуального окружения репозитория, на :8788.
core:
	cd .. && .venv/bin/python scripts/core_api.py

# API на хосте, на :8787 — там, куда по умолчанию ходит прокси Next.
api:
	set -a; [ -f $(ENV_FILE) ] && . $(ENV_FILE); set +a; go run -ldflags "-X main.version=$$(git rev-parse --short=12 HEAD 2>/dev/null || echo dev)" ./cmd/api -config $(CONFIG)

test:
	go test ./... -count=1

# Тесты хранилища идут против живой базы: моки базы проверяют моки.
test-db:
	TEST_DATABASE_URL="$(DSN)" go test ./... -count=1

lint:
	gofmt -l . | tee /dev/stderr | (! read)
	go vet ./...

# Код запросов генерирует sqlc по migrations/ и queries/.
sqlc:
	sqlc generate

build:
	go build ./...
