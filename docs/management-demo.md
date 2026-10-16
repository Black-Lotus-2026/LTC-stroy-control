# Запуск и показ управленческого слоя

Проверено 16 октября 2026. Это локальный демонстрационный стенд. Данные заказчика не использованы. Схемы камер и ставки условные; результат не доказывает фактический простой или экономию.

## Уже подготовленный стенд

- Интерфейс: http://127.0.0.1:5173, раздел **Отклонения** после входа.
- API: http://127.0.0.1:8000/docs.
- Локальный пользователь: `management_demo`, пароль `management-demo-local`. Это публичные реквизиты тестовой fixture, не внешний аккаунт.
- Объект: `MANAGEMENT-DEMO`, UUID `13ef06c8-2ef2-4761-9e16-fa6ac51b95e8`.
- PostgreSQL 14: `127.0.0.1:55432`, база `management_demo`; кластер `var/management-test/postgres` в корне репозитория. Redis 7: Docker-контейнер `ltc-management-test-redis`, порт `56379`.
- API и worker читают `backend/.env`. Сейчас `CELERY_EAGER=false`: задания действительно проходят Redis/Celery. Vite, API, worker и beat оставлены запущенными; после завершения процессов их нужно запустить снова.
- Проверенный baseline run: `943f0312-3853-4ca9-b2c8-00749385d6bf`. Его полный ответ сохранён в [verified_deterministic_run.json](../data/demo_management/verified_deterministic_run.json). Это экспорт локальной карточки, не live LLM ответ.

Из корня проекта, в отдельных терминалах:

```sh
# Если уже созданный Redis остановлен:
docker start ltc-management-test-redis
```

```sh
# Только если локальный кластер PostgreSQL остановлен:
/opt/homebrew/opt/postgresql@14/bin/pg_ctl -D var/management-test/postgres -l var/management-test/postgres.log -o '-h 127.0.0.1 -p 55432 -k /tmp' start
```

```sh
cd backend
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

```sh
cd backend
.venv/bin/python -m celery -A app.workers.celery_app:celery_app worker --pool=solo --concurrency=1 --queues=default --loglevel=WARNING
```

```sh
npm run dev -- --host 127.0.0.1 --port 5173
```

Celery beat для периодического завершения зависших запусков:

```sh
cd backend
.venv/bin/python -m celery -A app.workers.celery_app:celery_app beat --loglevel=WARNING --schedule /tmp/ltc-management-beat
```

Beat отдельно не запускался в проверенном стенде. Истечение аренды также проверяется при чтении карточки; задача `management.reap_expired` зарегистрирована и покрыта тестами. Не запускайте два beat с одним расписанием.

## Новый изолированный стенд

Нужны Python 3.12, Node/npm, Docker. Следующие команды предназначены для новой машины со свободными портами; на подготовленном стенде выше их выполнять повторно не нужно. Полный существующий Docker Compose в этой работе не проверялся.

```sh
docker run -d --name ltc-management-demo-postgres -p 127.0.0.1:55432:5432 -e POSTGRES_USER=management_test -e POSTGRES_PASSWORD=local_test_only -e POSTGRES_DB=management_demo pgvector/pgvector:pg16
docker run -d --name ltc-management-demo-redis -p 127.0.0.1:56379:6379 redis:7-alpine
python3.12 -m venv backend/.venv
cd backend
.venv/bin/python -m pip install -e '.[dev]'
```

Создайте `backend/.env` только если его ещё нет. Не перезаписывайте существующий ключ. Для нового стенда:

```dotenv
ENVIRONMENT=local
DEBUG=false
POSTGRES_HOST=127.0.0.1
POSTGRES_PORT=55432
POSTGRES_USER=management_test
POSTGRES_PASSWORD=local_test_only
POSTGRES_DB=management_demo
REDIS_HOST=127.0.0.1
REDIS_PORT=56379
CELERY_EAGER=false
STORAGE_LOCAL_ROOT=./var/storage
OPENROUTER_API_KEY=
OPENROUTER_MODEL=openai/gpt-4o-mini
```

```sh
# Из backend, только для этой новой локальной базы:
chmod 600 .env
.venv/bin/python -m alembic upgrade head
.venv/bin/python -m app.scripts.seed_management_demo --allow-local-demo
```

Seed ограничен `ENVIRONMENT=local`, loopback PostgreSQL и именем БД `management_demo`. Он создаёт тестового пользователя и объект, повторно не меняет пароль существующего пользователя. Затем запустите API/worker/frontend командами выше; перед первым запуском frontend выполните `npm ci` в корне.

Миграция `20261016_1200_005_management.py` добавляет три таблицы. Полная цепочка миграций и откат этой миграции проверены на отдельной PostgreSQL 16. Установка всех CV зависимостей с нуля и полный контейнерный образ отдельно не проверены. При запуске старого Compose используйте соответствующие docker-настройки из `.env.example`: локальные порты `55432/56379` не являются внутренними портами сети Compose.

## Короткий показ

1. Войти тестовым пользователем, выбрать демонстрационный объект и **Отклонения**.
2. В строке «Демо · проверка подачи самосвалов» нажать **Цена бездействия**. В мини-окне показаны **«Сценарная оценка · демо»**, **112 000 ₽**, условие **«Если задержка составит 8 раб. ч»** и график дополнительных затрат. Это не фактически понесённый ущерб.
3. Навести на график: сумма меняется по выбранному времени. Навести или нажать ⓘ: **96 000 ₽ простой + 16 000 ₽ продление графика**, использованные ставки и источник. Работают фокус, стрелки клавиатуры и повторное нажатие ⓘ. Начало отсчёта видно под графиком.
4. Закрыть крестиком, Escape или нажатием снаружи. Та же кнопка доступна у случаев в фотоархиве, отчётах и уведомлении о новом отклонении.
5. Название в окне — ссылка на существующую карточку случая в отчётах с ответственным и статусом. Для случая без расчёта окно называет нужные входы и кому передать их, без выдуманного графика. Подготовка профиля остаётся через API.

Это условная оценка будущих дополнительных затрат, не подтверждённый ущерб. **112 000 ₽** на графике — сценарий бездействия; **68 000 ₽** в сравнении сценариев — разница между быстрым вмешательством и бездействием. Не смешивать эти величины.

Подробный редактор, журнал ролей и сравнение сценариев убраны из основного UI по просьбе пользователя; backend/API и сохранённые результаты оставлены. Профиль реального случая с привязками к `ScheduleTask`, `RuleSet`, `Frame` и `CostRate` задаётся через API. [Текущее устройство простого экрана и проверка](simple-cost-ui.md).

## LLM и автономный режим

Ключ хранится только в игнорируемом `backend/.env` с правами 0600. Его нет в frontend, Git и экспорте карточки. После замены ключа и модели API/worker перезапущены. Текущая дешёвая модель — `openai/gpt-4o-mini`, каталог на момент проверки: $0.15 / $0.60 за миллион входных / выходных токенов. Модель меняется через `OPENROUTER_MODEL`; нужны поддержка structured outputs и доступ к модели в аккаунте.

**Проверенный реальный анализ:** run `0d64197f-bf4f-49a0-87f3-b3d9a7393f9d`, полный экспорт [verified_llm_run.json](../data/demo_management/verified_llm_run.json). Три отдельных вызова, все роли `completed/generation=llm`, 13.880 с с опросом API. Суммы 44 000 / 68 000 / 112 000 ₽ и перенос 0 / 0 / 4 ч воспроизведены калькулятором по сохранённому snapshot.

Сохранённый результат доступен по `GET /api/v1/management/runs/0d64197f-bf4f-49a0-87f3-b3d9a7393f9d` с Bearer auth и в экспорте выше. Итог `partial` означает замечания рецензента: он запросил подтверждение доступности техники и фактической загрузки. Предложение требует проверки человеком; это не утверждённое поручение. Мини-окно цены не запускает LLM и не выводит технический журнал.

Ранний ключ был management/provisioning и не допускал completions (401). Пользователь заменил его обычным ключом. Новые внешние ключи программно не создавались. Mistral дала таймауты; GPT-4.1 nano нарушала ограничения текста; доступ к Gemini был отклонён Google AI Studio. Неудачные попытки сохранены в [журнале измерений](../data/demo_management/live_provider_measurements.json), а не объявлены успешными.

Бесплатная проверка типа ключа, без секрета и без генерации:

```sh
cd backend
.venv/bin/python -m app.scripts.check_management_provider
```

Код выхода 2 означает management key, 1 — недоступность/ошибку проверки, 0 — распознанный обычный ключ. Код 0 сам по себе не доказывает генерацию ролей.

Без ключа режим `llm` помечает роли `skipped/provider_unavailable`; режим `deterministic` вообще не обращается к провайдеру. Для резервного показа без Redis можно явно включить `CELERY_EAGER=true` и перезапустить API: это синхронный режим. Сохранённые результаты читаются без LLM, опрос не запускает генерацию повторно.

Методика: [data/demo_management/README.md](../data/demo_management/README.md). Результаты и ограничения: [management-validation.md](management-validation.md).


После объединения с PR #2 схема обновлена до `20261016_1300`. Для актуальных алертов и расписаний нужен beat; команда приведена выше. Новый narrator отчётов и SMTP остаются выключенными. Проверки и сохранность данных: [main-integration.md](main-integration.md).
