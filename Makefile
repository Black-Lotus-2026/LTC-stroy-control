# Короткие команды для повседневной работы. Всё, что нужно знать новому
# участнику: make up, make logs, make down.

.PHONY: help up down logs ps rebuild migrate revision import-catalog shell test lint fmt

help:  ## Показать список команд
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

up:  ## Поднять весь стенд (api, worker, beat, postgres, redis, frontend)
	docker compose up --build -d
	@echo "Frontend: http://localhost:5173"
	@echo "API:      http://localhost:8000"
	@echo "Swagger:  http://localhost:8000/docs"

down:  ## Остановить стенд (данные сохраняются)
	docker compose down

logs:  ## Логи всех сервисов
	docker compose logs -f --tail=100

ps:  ## Статус контейнеров
	docker compose ps

rebuild:  ## Пересобрать образы с нуля
	docker compose build --no-cache

migrate:  ## Применить миграции
	docker compose exec api alembic upgrade head

revision:  ## Создать миграцию: make revision m="описание"
	# --user нужен, чтобы файл миграции принадлежал вам, а не root:
	# контейнер работает от root и иначе оставляет нередактируемые файлы.
	docker compose exec --user $(shell id -u):$(shell id -g) api \
		alembic revision --autogenerate -m "$(m)"

import-catalog:  ## Загрузить справочник видов работ из data/work_catalog.xlsx
	docker compose exec api python -m app.cli import-catalog

generate-demo:  ## Сгенерировать эталонный демо-файл календарного плана (Многоквартирный жилой дом)
	docker compose exec api python -m app.scripts.generate_demo_schedule

shell:  ## Python-консоль внутри контейнера api
	docker compose exec api python

test:  ## Прогнать тесты
	docker compose exec api pytest -q

lint:  ## Проверить стиль и типы
	docker compose exec api ruff check app
	docker compose exec api mypy app

fmt:  ## Отформатировать код
	docker compose exec api ruff format app
	docker compose exec api ruff check --fix app
