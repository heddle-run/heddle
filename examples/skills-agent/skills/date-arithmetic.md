Days between two dates, a weekday, or a date some interval away. Read this before stating any date you did not copy from the input.

Counting days by hand goes wrong at month ends and in February. Run it.

  bash: python3 -c "from datetime import date, timedelta; print((date(2026,3,1) - date(2025,11,14)).days)"

A weekday is print(date(2026,3,1).strftime('%A')). A date n days on is
print(date(2026,3,1) + timedelta(days=n)).

Quote the number the command printed. If a date arrives without a year, say
which year you took it to be instead of choosing one silently.
