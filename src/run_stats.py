"""Thread-safe counters for the per-run performance report.

Fetch modules bump named counters as they work (API calls, cache hits/misses, retries,
failures); the pipeline stamps stage durations; everything lands in
data/output/run_report.json at the end of the run so a slow run can be diagnosed from
the published output instead of by scrolling CI logs.
"""

import json
import threading
import time
from datetime import datetime, timezone

from src import config

_lock = threading.Lock()
_counters: dict[str, int] = {}
_stages: dict[str, float] = {}
_run_started_ts: float | None = None
_run_started_at: str | None = None


def reset() -> None:
    global _run_started_ts, _run_started_at
    with _lock:
        _counters.clear()
        _stages.clear()
        _run_started_ts = time.monotonic()
        _run_started_at = datetime.now(timezone.utc).isoformat()


def bump(counter: str, amount: int = 1) -> None:
    with _lock:
        _counters[counter] = _counters.get(counter, 0) + amount


class stage:
    """Context manager that records how long a named pipeline stage took."""

    def __init__(self, name: str) -> None:
        self.name = name

    def __enter__(self) -> "stage":
        self._start = time.monotonic()
        return self

    def __exit__(self, *exc_info) -> None:
        elapsed = time.monotonic() - self._start
        with _lock:
            _stages[self.name] = round(_stages.get(self.name, 0.0) + elapsed, 2)


def write_report(extra: dict | None = None) -> dict:
    """Write data/output/run_report.json and return the report dict."""
    with _lock:
        runtime = round(time.monotonic() - _run_started_ts, 1) if _run_started_ts else None
        report = {
            "started_at": _run_started_at,
            "finished_at": datetime.now(timezone.utc).isoformat(),
            "runtime_seconds": runtime,
            "stages_seconds": dict(sorted(_stages.items(), key=lambda kv: -kv[1])),
            "counters": dict(sorted(_counters.items())),
        }
    if extra:
        report.update(extra)
    (config.OUTPUT_DIR / "run_report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report
