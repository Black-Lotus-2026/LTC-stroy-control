# Один образ на три роли (api, worker, beat) — различаются только командой
# запуска. Меньше сборок, и версии зависимостей гарантированно совпадают.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# libpq нужен psycopg, curl — для healthcheck в compose.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libpq5 curl libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Зависимости ставятся отдельным слоем: пересобираются только при изменении
# pyproject.toml, а не при каждой правке кода.
COPY pyproject.toml ./
# Dev-зависимости ставятся в тот же образ: тесты и линтеры запускаются
# внутри контейнера (make test, make lint), отдельная сборка для этого
# в рамках прототипа не оправдана.
RUN pip install --upgrade pip && pip install ".[dev]"

COPY . .

# Переустановка кода как editable: без этого `import app` брал бы копию,
# вшитую в образ на предыдущем шаге, и правки в примонтированном томе
# не применялись бы.
RUN pip install -e . --no-deps

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
