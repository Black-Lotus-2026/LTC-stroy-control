# Короткие команды для повседневной работы. Всё, что нужно знать новому
# участнику: make up, make logs, make down.

.PHONY: help up down logs ps rebuild migrate revision shell test lint fmt

help:  ## Показать список команд
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

up:  ## Поднять весь стенд (api, worker, beat, postgres, redis)
	docker compose up --build -d
	@echo "API:     http://localhost:8000"
	@echo "Swagger: http://localhost:8000/docs"

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
	docker compose exec api alembic revision --autogenerate -m "$(m)"

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
