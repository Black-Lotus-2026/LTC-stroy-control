"""One daytime shift, explicit weekdays and exceptions; timestamps returned in UTC.

Working durations use elapsed seconds inside the configured local shift. Calendar
day tariffs are prorated by elapsed seconds / 86400, never by an assumed 8h day.
"""

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from app.schemas.management import WorkCalendar

UTC = UTC
ZERO = Decimal(0)
HOUR_US = Decimal(3_600_000_000)
MAX_CALENDAR_DAYS = 366 * 200


def elapsed_hours(start: datetime, end: datetime) -> Decimal:
    delta = end.astimezone(UTC) - start.astimezone(UTC)
    return (
        Decimal((delta.days * 86400 + delta.seconds) * 1_000_000 + delta.microseconds)
        / HOUR_US
    )


def shift_hours(calendar: WorkCalendar) -> Decimal:
    anchor = date(2000, 1, 1)
    return elapsed_hours(
        datetime.combine(anchor, calendar.shift_start, UTC),
        datetime.combine(anchor, calendar.shift_end, UTC),
    )


def shift_bounds(day: date, calendar: WorkCalendar) -> tuple[datetime, datetime] | None:
    if day in calendar.holidays:
        return None
    if (
        day.weekday() not in calendar.working_weekdays
        and day not in calendar.extra_working_dates
    ):
        return None
    tz = ZoneInfo(calendar.timezone)
    return (
        datetime.combine(day, calendar.shift_start, tz).astimezone(UTC),
        datetime.combine(day, calendar.shift_end, tz).astimezone(UTC),
    )


def work_intervals(start: datetime, end: datetime, calendar: WorkCalendar):
    """Yield disjoint [start,end) UTC shift intersections."""
    start, end = start.astimezone(UTC), end.astimezone(UTC)
    if end <= start:
        return
    tz = ZoneInfo(calendar.timezone)
    day, last = start.astimezone(tz).date(), end.astimezone(tz).date()
    if (last - day).days > MAX_CALENDAR_DAYS:
        raise ValueError("Calendar horizon exceeds 200 years")
    while day <= last:
        bounds = shift_bounds(day, calendar)
        if bounds:
            left, right = max(start, bounds[0]), min(end, bounds[1])
            if right > left:
                yield left, right
        day += timedelta(days=1)


def working_hours_between(
    start: datetime, end: datetime, calendar: WorkCalendar
) -> Decimal:
    if end < start:
        return -working_hours_between(end, start, calendar)
    return sum(
        (elapsed_hours(a, b) for a, b in work_intervals(start, end, calendar)), ZERO
    )


def next_work_start(moment: datetime, calendar: WorkCalendar) -> datetime:
    moment = moment.astimezone(UTC)
    day = moment.astimezone(ZoneInfo(calendar.timezone)).date()
    for _ in range(MAX_CALENDAR_DAYS):
        bounds = shift_bounds(day, calendar)
        if bounds and moment < bounds[1]:
            return max(moment, bounds[0])
        day += timedelta(days=1)
    raise ValueError("No working shift in supported calendar horizon")


def add_work_hours(moment: datetime, hours: Decimal, calendar: WorkCalendar) -> datetime:
    hours = Decimal(hours)
    if not hours.is_finite() or hours < 0:
        raise ValueError("Working duration must be finite and nonnegative")
    # A zero offset represents the same instant, including an exact shift end.
    if hours == 0:
        return moment.astimezone(UTC)
    cursor = next_work_start(moment, calendar)
    for _ in range(MAX_CALENDAR_DAYS):
        bounds = shift_bounds(
            cursor.astimezone(ZoneInfo(calendar.timezone)).date(), calendar
        )
        assert bounds is not None
        available = elapsed_hours(cursor, bounds[1])
        if hours <= available:
            return cursor + timedelta(microseconds=int(hours * HOUR_US))
        hours -= available
        cursor = next_work_start(bounds[1], calendar)
    raise ValueError("Calendar horizon exceeds 200 years")
