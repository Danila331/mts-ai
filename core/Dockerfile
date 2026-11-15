# Образ Python-ядра (scripts/core_api.py). Контекст сборки — корень
# репозитория: ядру нужны energybot/ и knowledge-base/.
#
# Тот же Python, что у платформы организаторов и в CI: ответ ядра на
# стенде должен совпадать с ответом сабмита.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Зависимости ядра — ровно те, что у сабмита (httpx, numpy), а не
# requirements.txt с полным набором платформы: образ меньше впятеро,
# и ядро не начнёт молча опираться на то, чего в сабмите нет.
COPY solution-requirements.txt ./
RUN pip install -r solution-requirements.txt \
 && useradd --uid 65532 --no-create-home core

COPY energybot ./energybot
COPY knowledge-base ./knowledge-base
COPY scripts/core_api.py scripts/index_cache.py ./scripts/

# Каталог кеша векторов (EB_INDEX_CACHE_DIR). Создаётся здесь, с владельцем
# core: том docker перенимает владельца каталога образа, и непривилегированное
# ядро может в него писать.
RUN mkdir -p /data/index && chown core /data/index

USER core

# 0.0.0.0 подходит docker compose. На Railway приватная сеть — IPv6,
# там переменная EB_CORE_HOST=:: (см. docs/deploy.md).
ENV EB_CORE_HOST=0.0.0.0 \
    EB_CORE_PORT=8788
EXPOSE 8788

CMD ["python", "scripts/core_api.py"]
