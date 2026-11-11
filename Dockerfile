# Веб-прототип ИИ-консультанта МТС EnergyTool: FastAPI + SQLite + статический чат.
# Ключи и адрес API подаются окружением (см. .env.example), в образ не попадают.
FROM python:3.11-slim

WORKDIR /app
COPY webapp/requirements-web.txt ./
RUN pip install --no-cache-dir -r requirements-web.txt

COPY energybot ./energybot
COPY webapp ./webapp
COPY knowledge-base ./knowledge-base

ENV KB_PATH=/app/knowledge-base \
    WEBAPP_DB=/data/webapp.sqlite3 \
    PYTHONUNBUFFERED=1
VOLUME /data
EXPOSE 8000

CMD ["python", "-m", "webapp.app"]
