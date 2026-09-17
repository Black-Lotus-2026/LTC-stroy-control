# Агент автоматических отчётов

## Цель

Прораб запрашивает проверяемую сводку за последний час, день, неделю или
произвольный интервал. Тот же отчёт может создаваться автоматически по
расписанию. Источниками станут CCTV, результаты CV-обработки, VLC/архив,
системные события и ручные записи.

Первая версия использует одного агента. Это осознанно: задача представляет
собой один линейный сценарий, поэтому multi-agent orchestration добавила бы
сложность без новых возможностей.

## Поток данных

```text
CCTV / CV / VLC / оператор
           │
           ▼
   observation_logs             единый формат + occurred_at UTC
           │
           ▼
 ConstructionReportAgent
           │ вызывает
           └── timeline_search  выборка строго за заданный интервал
           │
           ▼
 метрики + факты + trace
           │
           ├── LangChain / OpenAI  опциональный narrative
           └── template fallback    если LLM выключен или недоступен
           │
           ▼
   generated_reports            текст, метрики, разделы, trace источников
           ▲
           │
 report_schedules ── Celery beat каждую минуту проверяет наступившие запуски
```

Каждый вывод содержит `trace.source_log_ids`. Поэтому можно открыть исходные
записи, проверить временной диапазон и понять, на каких фактах построена
сводка. Агент не создаёт факты, которых нет в журнале.

## LLM через LangChain

LLM-narrator подключён через `langchain-openai`. Он использует
OpenAI Responses API и Structured Outputs: модель возвращает только
`executive_summary`, сводки разделов и `manager_actions`. События,
числовые метрики, limitations и trace остаются результатом
детерминированного кода.

Для Docker скопируйте пример в корень репозитория и заполните ключ:

```bash
cp backend/.env.example .env
# в .env:
REPORT_LLM_ENABLED=true
OPENAI_API_KEY=<secret>
```

После изменения Python-зависимостей нужна пересборка:

```bash
docker compose up --build
```

Для локального запуска те же переменные задаются в `backend/.env`.
`OPENAI_API_KEY` не хранится в БД и не попадает в отчёт. Во внешний
запрос передаются нормализованные факты, но не `source_log_ids` и не
`evidence_url`. Если такая передача данных недопустима, оставьте
`REPORT_LLM_ENABLED=false`.

Статус формирования виден в `content.trace.narrative`: `completed`,
`disabled` или `fallback`. При таймауте, ошибке API или отсутствии
ключа отчёт всё равно завершается через template fallback.

## Почему нормализованный журнал

Сырые события разных источников имеют разные форматы. Таблица
`observation_logs` оставляет общие поля (`project`, `camera`, `zone`,
`category`, `severity`, `occurred_at`) стабильными, а специфичные значения
хранит в `payload`. Подключение нового CV-сервиса меняет адаптер записи, но не
агента и не API отчётов.

Все timestamps хранятся в UTC. Часовой пояс проекта используется только для
расчёта расписания и представления времени пользователю.

## Контракт API

Сформировать отчёт за последний день:

```http
POST /api/v1/reports/generate
Content-Type: application/json

{
  "project_id": "<uuid проекта>",
  "period": "day"
}
```

Поддерживаются `hour`, `day`, `week`, `custom`. Для `custom` обязателен
`range_start`; `range_end` по умолчанию равен текущему времени. Максимальный
интервал — 31 день.

Создать ежедневное расписание на 20:05 по Москве:

```http
POST /api/v1/reports/schedules
Content-Type: application/json

{
  "project_id": "<uuid проекта>",
  "name": "Сводка за смену",
  "frequency": "daily",
  "report_period": "day",
  "timezone": "Europe/Moscow",
  "run_at_local": "20:05:00"
}
```

Также доступны:

- `GET /api/v1/reports?project_id=<uuid>` — история;
- `GET /api/v1/reports/{id}` — один отчёт;
- `GET /api/v1/reports/schedules?project_id=<uuid>` — расписания;
- `PATCH /api/v1/reports/schedules/{id}` — включение и изменение времени.

## Соответствие frontend

Ответ агента повторяет смысл разделов существующего экрана «Отчёты»:

| Frontend | `content.sections[].key` | Источник |
|---|---|---|
| Состояние камер | `camera_state` | camera events |
| Подтверждённые события | `confirmed_events` | safety/PPE + status |
| Люди и техника | `people_equipment` | safety/PPE/equipment |
| Наблюдаемый прогресс | `observed_progress` | progress events |
| Ключевые доказательства | `key_evidence` | `payload.evidence_url` |
| Недостающие данные | `missing_data` | data/camera warnings |

Сейчас frontend использует `src/data.ts` и `mockApi`. Для интеграции нужно
заменить их в экране отчётов вызовами перечисленных endpoints; контракт уже
возвращает все данные, которые нужны текущему макету.

## Mock-данные

После запуска Docker-стенда:

```bash
make seed-report-demo
```

Команда создаёт demo-проект, зоны, камеры, 14 timestamped событий за неделю и
два расписания. Повторный запуск заменяет demo-таймлайн и ранее созданные по
нему demo-отчёты, поэтому данные и trace не расходятся. UUID проекта выводится
в лог и используется в API-запросах.

## Границы первой версии

- LLM формулирует narrative, но не верифицирует видео и не пересчитывает
  метрики; при выключенной интеграции работает template fallback.
- PDF-файл пока не рендерится: результат хранится как структурированный JSON.
- Адаптеры приёма реальных CCTV/CV/VLC-событий ещё не подключены.
- Доставка отчёта в Telegram/email и разграничение доступа — следующий слой.

Метрики, список событий, ограничения и trace остаются результатом
детерминированных tools.
