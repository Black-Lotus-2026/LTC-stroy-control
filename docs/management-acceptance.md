# Аудит основного результата

16 октября 2026. Объём взят из разделов «Обязательный минимум» и «Критерии приёмки» FINAL_SPRINT_PLAN.md. Основной сквозной путь проверен, включая три настоящие роли OpenRouter на обычном ключе. Сохранённый run `0d64197f-bf4f-49a0-87f3-b3d9a7393f9d`: все роли completed/generation=llm. Рецензент выдал needs_revision из-за неподтверждённой доступности техники и фактической загрузки: это содержательный результат проверки, а не фиктивный допуск. Итог карточки partial/effective_mode=llm; условная рекомендация fast и точные суммы сохранены. Проверка CV на реальном объекте и утверждение действия человеком в объём готового не включаются.

Ниже `S`, `C`, `A`, `H`, `L` обозначают файлы `backend/tests/test_management_schedule.py`, `test_management_costs.py`, `test_management_agents.py`, `test_management_api.py`, `test_management_lifecycle.py`. Их совместный полный запуск с остальными backend тестами дал 168 passed, 0 skipped; команда и окружение — в [отчёте](management-validation.md). Названия тестов позволяют проверить границы утверждения, а не только общий зелёный итог.

## График и деньги

| Требование | Свидетельство | Итог |
|---|---|---|
| Точные суммы и перенос | C `test_exact_control_costs_and_conditional_difference`, сохранённый [run](../data/demo_management/verified_deterministic_run.json), Safari baseline | Подтверждено на условных входах |
| Запас поглощает задержку | S `test_monotonic_recovery_and_true_slack_episode`, Safari slack | Подтверждено |
| Более позднее восстановление не ускоряет график | S `test_monotonic_recovery_and_true_slack_episode`, цикл значений 0–11 | Подтверждено в поддерживаемой FS модели |
| Независимая ветвь не сдвигается | S `test_control_graph_parallel_slack_and_preserves_plan` | Подтверждено |
| Циклы/чужие объекты отклоняются | S `test_invalid_edges_are_rejected`, `test_cross_project_task_rejected_at_contract_boundary`; H `test_bad_graph_is_rejected_before_persistence_or_queue` | Подтверждено |
| Плановые даты неизменны, завершённые задачи сохраняют факт | S `test_control_graph_parallel_slack_and_preserves_plan`, `test_completed_task_actual_finish_is_preserved_and_not_future_work` | Подтверждено |
| Календарь/смена/выходные/исключения | S `test_calendar_shift_end_weekend_and_exceptions`, `test_after_hours_start_and_nonstandard_shift` | Подтверждено; ночная смена явно отклоняется отдельным тестом |
| Null остаётся неизвестным, деньги Decimal | C `test_unknown_rate_remains_null_and_no_comparison`, `test_fractional_decimal_money_without_float_error`, проверки больших значений/копеек | Подтверждено |
| Реакция однократно, пересечения не суммируются | C `test_one_time_cost_and_exact_duplicate_resource_not_double_counted`, `test_ambiguous_groups_and_unknown_extension_composition_prevent_total` | Подтверждено |
| Дорогая реакция допускает отрицательный эффект | C `test_expensive_action_has_negative_effect`, Safari expensive_action | Подтверждено; UI выбирает допустимый более дешёвый вариант |
| Прошлое не превращается в предотвращаемые затраты | C `test_past_rate_does_not_become_future_avoidable_cost` | Подтверждено |

## Роли

| Требование | Свидетельство | Итог |
|---|---|---|
| Три отдельные схемы/контекста/вызова | `agents/{evidence,actions,reviewer}.py`, A `test_three_separate_calls_are_validated_and_accounted` | Реализация, mock и три настоящие генерации подтверждены сохранённым run |
| Source/metric refs только из разрешённого контекста | A `test_observation_must_be_grounded_not_just_have_valid_reference`, `test_metric_references_must_exist_and_belong_to_scenario`, `test_metric_prefix_cannot_hide_unknown_metric` | Подтверждено тестами валидаторов |
| Модель не заменяет суммы | A `test_agent_cannot_write_factual_money`, `test_calculation_guard_keeps_cents_beyond_default_decimal_precision` | Подтверждено тестами; UI числа берёт из ScenarioResult |
| Гипотеза не становится фактом | A `test_hypothesis_never_promoted_by_llm` | Подтверждено mock ответом с попыткой повышения |
| Пробелы сохраняются до финальной карточки | A `test_evidence_gaps_must_survive_both_later_roles`; Safari camera_unavailable | Подтверждено |
| Timeout/ошибка/схема ограничены | A `test_provider_failure_is_bounded_and_sanitized`, `test_bad_schema_repair_does_not_loop`, `test_pipeline_enforces_wall_clock_deadline_for_slow_provider`; L budget/lease | Подтверждено тестами и реальным 401 fallback |
| Отключение LLM не меняет арифметику | A `test_deterministic_mode_never_calls_provider_and_keeps_math`; пять реальных queue runs | Подтверждено |
| Инструкции в данных не расширяют доступ | A `test_injection_stays_in_data_and_urls_are_not_sent`; фиксированный provider endpoint | Подтверждено программными ограничениями; автономных tools у модели нет |
| Три настоящие роли анализируют и проверяют результат | [Реальный run](../data/demo_management/verified_llm_run.json), три вызова GPT-4o mini; валидаторы и повторный калькулятор, Safari | Подтверждено; замечания рецензента сохранены, допуск не выдуман |

## API и сохранение

| Требование | Свидетельство | Итог |
|---|---|---|
| Чужой профиль/run/trace недоступен | H `test_auth_and_foreign_project_profile_run_trace_are_denied`, `test_viewer_reads_owned_project_but_cannot_mutate` | Подтверждено для management endpoints; старые CRUD остаются отдельным P0 |
| Чужой incident/task/parent/frame/rate отклоняется | H `test_foreign_incident_task_parent_and_evidence_are_rejected`, проверки CostRate и связи incident/task | Подтверждено |
| Idempotency без дублей | H `test_idempotency_and_duplicate_worker_do_not_repeat_analysis_or_incident`; пять повторов настоящих POST | Подтверждено |
| Повтор worker и конкуренция не создают второй результат | L `test_postgres_concurrent_deliveries_make_only_one_run`, `test_duplicate_delivery_during_provider_and_after_completion_never_charges`; реальная redelivery | Подтверждено для run; поручения ещё отсутствуют |
| Новая ставка не меняет историю | H `test_profile_and_new_version_do_not_mutate_saved_inputs_or_results`; C `test_saved_result_and_hash_unaffected_by_later_rate_changes` | Подтверждено API/чистыми тестами и браузером: ставка 8000→9000, сохранить без расчёта, reload → новая ставка и прежняя сумма карточки |
| Reload/перезапуск/фон дают согласованный результат | Safari reload; повторное HTTP чтение fast3 после перезапуска API/worker; [queue measurements](../data/demo_management/queue_measurements.json) | Подтверждено |
| UUID/project_id/статус | H complete path, persisted status, unknown status; Safari PATCH→GET и reload | Подтверждено |
| Пустота не порождает событие | H `test_empty_evidence_remains_empty_and_requires_input`; удалены fake fallback в клиенте/API | Подтверждено кодом и тестом |

## Интерфейс и артефакты

| Требование | Свидетельство | Итог |
|---|---|---|
| Сквозной путь через UI без ручной БД | [Safari отчёт](management-ui-validation.md), baseline/fast3/history/status | Подтверждено для demo/deterministic; настоящий LLM run создан API и открыт в UI |
| Три сценария видны одновременно, единицы/источники доступны | Финальные 1280×800 снимки, раскрытые расчёты | Подтверждено Safari |
| Нет выдуманных вероятностей срыва | `ManagementPanel.tsx`, сценарии и сравнение вместо процентов | Подтверждено для нового раздела |
| Этапы running/skipped/failed различимы | UI badges по статусу; открыта реальная failed LLM карточка, журнал skipped deterministic | В Safari открыта карточка 0d6419: все четыре этапа завершены, «LLM: есть замечания» |
| Replay и условные входы обозначены | Снимки и тексты карточки, SVG «DEMO/СХЕМА» | Подтверждено |
| Ошибка не выдаётся за успешное сохранение | Клиент проверяет response.ok; H `test_failed_broker_is_persisted_without_false_success_or_get_retry` | Код/HTTP тест подтверждены; намеренная ошибка сети в браузере не моделировалась |
| Удобство ноутбука | Safari 1280×800 и финальные снимки | Подтверждено в Safari; другие браузеры не проверены |
| Четыре эпизода | Baseline, camera_unavailable, slack, expensive_action: JSON + тесты + Safari | Подтверждено |
| Запуск/данные/методика/лимиты/измерения/передача | [Запуск](management-demo.md), [fixtures и методика](../data/demo_management/README.md), [архитектура](management-architecture.md), [проверки](management-validation.md), [handoff](agent-handoff.md) | Подготовлено; ключевые команды выполнены, полный Compose не заявлен проверенным |

Поручения, общий приоритет нескольких объектов и управленческая сводка перечислены в плане как следующий приоритет, их наличие не имитируется. Проверка CV и ставок на реальном объекте и сравнение полезности ролей с шаблоном остаются непроверенными. Успех внешних вызовов подтверждён; содержательные замечания рецензента и отказы в других попытках сохраняются явно. По просьбе пользователя после основной реализации выполнены две независимые критики; четыре P2 исправлены и повторно проверены, см. [отчёт](management-critic-review.md).
