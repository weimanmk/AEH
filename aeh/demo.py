"""Command-line entry point for the Step 2 synthetic demo.

Examples::

    python -m aeh.demo
    python -m aeh.demo --audience guardian
    python -m aeh.demo --json

The command is offline and uses only the in-memory synthetic fixtures in
:mod:`aeh.demo_session`; no file or network access is performed.
"""

from __future__ import annotations

import argparse
import json
from typing import Sequence

from .demo_session import (
    DEMO_WINDOW_END,
    DEMO_WINDOW_START,
    DemoError,
    DemoResult,
    run_demo,
)
from .report import AUDIENCE_GUARDIAN, AUDIENCE_TEACHER, LearningReport, generate_report


def build_demo_report(
    result: DemoResult, *, audience: str = AUDIENCE_TEACHER
) -> LearningReport:
    """Build a teacher/guardian report from the demo's aggregate events only."""
    return generate_report(
        result.report_events,
        audience=audience,
        student_ref=result.student_ref,
        window_start=DEMO_WINDOW_START,
        window_end=DEMO_WINDOW_END,
        generated_at=result.twin_state.last_observed_at,
    )


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m aeh.demo",
        description=(
            "AEH Step 2 合成演示：拍题 → 批改 → 诊断 → 复习，"
            "并生成仅含授权聚合数据的教师/家长报告。"
        ),
    )
    parser.add_argument(
        "--audience",
        choices=(AUDIENCE_TEACHER, AUDIENCE_GUARDIAN),
        default=AUDIENCE_TEACHER,
        help="报告受众：teacher（默认）或 guardian",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="输出机器可读 JSON（演示轨迹 + 聚合报告）",
    )
    args = parser.parse_args(argv)

    try:
        result = run_demo()
        report = build_demo_report(result, audience=args.audience)
    except DemoError as exc:
        parser.exit(2, f"demo failed: {exc}\n")

    if args.json:
        payload = {"demo": result.to_dict(), "report": report.as_dict()}
        print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
    else:
        print(result.render_text())
        print(report.to_markdown())
    return 0


if __name__ == "__main__":  # pragma: no cover - exercised by the CLI
    raise SystemExit(main())
