"""Консольные команды бэкенда.

Запуск: python -m app.cli <команда>
Через Docker: docker compose exec api python -m app.cli <команда>

Команды намеренно вынесены из HTTP-слоя: импорт справочника и наполнение
демонстрационными данными — операции администратора, а не пользователя.
"""

from __future__ import annotations

import argparse
import logging
import sys

from app.core.logging import setup_logging
from app.db.session import session_scope
from app.services.report_demo_data import seed_report_demo
from app.services.work_catalog import import_work_catalog, parse_work_catalog

logger = logging.getLogger("app.cli")

DEFAULT_CATALOG_PATH = "data/work_catalog.xlsx"


def cmd_import_catalog(args: argparse.Namespace) -> int:
    """Загрузить справочник видов работ из xlsx в базу."""
    if args.dry_run:
        report = parse_work_catalog(args.path)
        logger.info("Разобрано строк: %s", report.total)
        logger.info("Кодов восстановлено из дат: %s", report.recovered_codes)
        logger.info("Строк без кода в файле: %s", report.rows_without_code)
        logger.info("Распределение по уровням: %s", report.by_level)
        logger.info("Режим проверки: в базу ничего не записано.")
        return 0

    with session_scope() as db:
        stats = import_work_catalog(db, args.path, replace=args.replace)

    logger.info(
        "Создано: %s, обновлено: %s, удалено: %s",
        stats.created,
        stats.updated,
        stats.deleted,
    )
    logger.info("Кодов восстановлено из дат: %s", stats.recovered_codes)
    logger.info("Строк без кода в файле: %s", stats.rows_without_code)
    logger.info("Распределение по уровням: %s", stats.by_level)
    return 0


def cmd_seed_report_demo(_: argparse.Namespace) -> int:
    """Создать mock-таймлайн и расписания для демонстрации отчётов."""
    with session_scope() as db:
        result = seed_report_demo(db)
    logger.info("Демо-проект: %s", result.project_id)
    logger.info("Создано записей журнала: %s", result.logs_created)
    logger.info("Создано расписаний: %s", result.schedules_created)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="app.cli", description="Служебные команды сервиса «Строй-контроль»"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    catalog = subparsers.add_parser(
        "import-catalog",
        help="Загрузить справочник видов работ из xlsx",
    )
    catalog.add_argument(
        "path",
        nargs="?",
        default=DEFAULT_CATALOG_PATH,
        help=f"Путь к файлу справочника (по умолчанию {DEFAULT_CATALOG_PATH})",
    )
    catalog.add_argument(
        "--replace",
        action="store_true",
        help=(
            "Удалить виды работ, которых нет в файле. Внимание: каскадно "
            "удалит правила, ссылающиеся на них."
        ),
    )
    catalog.add_argument(
        "--dry-run",
        action="store_true",
        help="Только разобрать файл и показать итог, ничего не записывая",
    )
    catalog.set_defaults(func=cmd_import_catalog)

    report_demo = subparsers.add_parser(
        "seed-report-demo",
        help="Создать mock-логи CCTV/CV/VLC и расписания отчётов",
    )
    report_demo.set_defaults(func=cmd_seed_report_demo)

    return parser


def main(argv: list[str] | None = None) -> int:
    setup_logging()
    args = build_parser().parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    sys.exit(main())
