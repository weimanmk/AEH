#!/usr/bin/env python3
"""Step 18 isolated end-to-end acceptance runner (synthetic only).

Boots the AEH dsh/Cordis plugin inside an **independent** dsh instance and runs
one synthetic gate -> diagnosis -> review -> report session with the Sidrune
model:

- own `$DSH_HOME`      : `step18/home` (never `~/.dsh`)
- own profile          : `step18/home/profiles/aeh-e2e` (never the headless one)
- own npm install      : `step18/runtime/node_modules` (`@deepseek-ai/dsh@0.2.1-rc.3`)
- own synthetic host   : `dsh-plugin/e2e/aeh-e2e-entry.ts`
- Sidrune credential   : obtained through the registered `custom.sidrune`
                         connector as an `hsurr:` surrogate and passed to the
                         child environment only; it is never printed or written.

The running harness's `~/.dsh`, its npx install, and the
`~/workspace/deepseek-harness` clone are never read or written.

Usage:
    python3 step18/run-e2e.py            # run the session and write evidence
    python3 step18/run-e2e.py --dry-run  # set up + dump composed config only
    python3 step18/run-e2e.py --task-file step18/task.md   # custom synthetic task
"""

from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

STEP18 = Path(__file__).resolve().parent
REPO = STEP18.parent
HOME = STEP18 / "home"
PROFILE = HOME / "profiles" / "aeh-e2e"
WORK = STEP18 / "work"
EVIDENCE = STEP18 / "evidence"
RUNTIME = STEP18 / "runtime"
DSH_ENTRY = RUNTIME / "node_modules" / "@deepseek-ai" / "dsh" / "lib" / "bin.js"
AEH_ENTRY = REPO / "dsh-plugin" / "e2e" / "aeh-e2e-entry.ts"
PROFILE_NAME = "aeh-e2e"

PROFILE_PACKAGE = {
    "name": "dsh-profile-aeh-e2e",
    "version": "0.0.0",
    "private": True,
    "description": (
        "AEH Step 18 isolated profile: dsh-base + dsh-headless plus the AEH "
        "plugin with its synthetic host. Never loaded by the running harness."
    ),
    "dsh": {
        "profile": {
            "bundles": [
                "@deepseek-ai/dsh-base",
                "@deepseek-ai/dsh-headless",
            ]
        }
    },
}

# Surface tools the acceptance session does not need. Disabling them keeps the
# synthetic run focused on the six aeh_* tools and removes any path to a shell,
# filesystem write, web, or subagent. Row ids come from @deepseek-ai/dsh-base.
DISABLED_ROWS = [
    "tool-bash",
    "tool-pwsh",
    "tool-fs",
    "tool-fs-search",
    "tool-jobs",
    "tool-skill",
    "tool-todo",
    "tool-web",
    "tool-subagent",
    "tool-subagent-control",
    "tool-subagent-list-agents",
    "tool-subagent-fork",
    "tool-workflow",
    "tool-goal",
    "tool-working-directory",
    "user-questions",
    "agent-instructions",
]

PROFILE_PATCH_TEMPLATE = """\
# AEH Step 18 isolated profile patch (synthetic only).
#
# This file lives under $DSH_HOME/profiles/aeh-e2e in the repository's own
# step18/home, never in ~/.dsh. It composes the shipped dsh-base and
# dsh-headless bundles, routes the model through the Sidrune provider, and
# mounts the AEH plugin with its synthetic host resolver.
#
# `__AEH_E2E_ENTRY_URL__` is substituted by step18/run-e2e.py with the
# absolute file URL of dsh-plugin/e2e/aeh-e2e-entry.ts.

# Provider route: the credential is resolved per request from the launch
# environment (headless disables the managed credential store).
- id: llm-pi-ai
  config:
    providers:
      sidrune:
        displayName: Sidrune
        apiKeyEnv: SIDRUNE_API_KEY
        api: openai-completions
        baseURL: https://sidrune.ai/v1
        models:
          - id: deepseek-v4-1-flash

- id: agent-default-model
  config:
    provider: sidrune
    model: deepseek-v4-1-flash

{disabled_rows}

# Mount the AEH education plugin with the host-owned synthetic resolver.
- insert:
    - id: aeh-education-e2e
      name: __AEH_E2E_ENTRY_URL__
      config:
        profile: student-facing
        targetRetention: 0.9
        allowedModes: ['preview', 'learn', 'review']
"""

DEFAULT_TASK = """\
You are running exactly one synthetic AEH (Adaptive Education Harness)
acceptance session. Every value below is synthetic test data. Use ONLY the six
`aeh_*` tools; do not read files and do not run shell commands.

Student reference: synthetic.student.step18. Gate mode: learn.
Target retention: 0.9.

Execute the following stages in order, copying each JSON argument exactly.

STAGE A - curriculum gate (curriculum gate / 门禁):
A1. Call aeh_check_curriculum with exactly:
{"mode":"learn","itemId":"item.fraction.add.001","studentRef":"synthetic.student.step18"}
A2. Call aeh_check_curriculum with exactly:
{"mode":"learn","itemId":"item.fraction.multiply.001","studentRef":"synthetic.student.step18"}
The second item must be refused by the fail-closed gate.

STAGE B - diagnosis (diagnosis / 诊断):
B1. Call aeh_update_hypotheses with exactly:
{"operation":"spawn","state":{"hypotheses":[],"unknownWeight":0.5},"hypothesis":{"hypothesisId":"hyp.adds_ok","predictedObservableBehaviors":{"item.fraction.equiv.001":0.8,"item.fraction.compare.001":0.3},"knowledgeAssumptions":{"kc.fraction.equiv":"understood"},"weight":0.5}}
B2. Call aeh_select_probe with exactly:
{"mode":"learn","studentRef":"synthetic.student.step18","weights":{"hyp.adds_ok":0.5,"unknown":0.5},"candidates":[{"itemId":"item.fraction.equiv.001","predictions":{"hyp.adds_ok":0.8},"timeMinutes":3,"risk":0.1,"cognitiveLoad":0.25,"teachingValue":0.5},{"itemId":"item.fraction.compare.001","predictions":{"hyp.adds_ok":0.3},"timeMinutes":4,"risk":0.2,"cognitiveLoad":0.3,"teachingValue":0.4}]}

STAGE C - review scheduling (review / 复习):
C1. Call aeh_schedule_review with exactly:
{"state":{"learnerRef":"synthetic.student.step18","memoryUnitId":"kc.fraction.add","stabilityDays":2,"difficulty":5,"observationCount":3,"independentSuccessCount":2,"modelFamily":"aeh.fsrs.illustrative","modelVersion":"v1"},"observations":[{"observationId":"obs.step18.1","success":true,"independent":true,"kind":"attempt","occurredAt":"2026-03-02T09:00:00Z"}],"targetRetention":0.9}

STAGE D - aggregate report (report / 报告):
D1. Call aeh_generate_report with exactly:
{"audience":"teacher","studentRef":"synthetic.student.step18","windowStart":"2026-03-01T00:00:00Z","windowEnd":"2026-03-08T00:00:00Z","events":[{"aggregateRef":"agg.step18.1","studentRef":"synthetic.student.step18","occurredAt":"2026-03-02T09:00:00Z","kind":"attempt_aggregate","consentScope":"educational_report","kcId":"kc.fraction.add","attempts":4,"independentCorrect":3,"hintsRequested":1,"minutes":10}]}

After D1, stop calling tools and reply with a short final summary of: the two
gate decisions, the selected probe item (or null), the review interval in days,
and the report attempt totals.
"""


def _disabled_rows_yaml() -> str:
    return "\n".join(
        f"- id: {row}\n  disabled: true" for row in DISABLED_ROWS
    )


def write_profile() -> None:
    PROFILE.mkdir(parents=True, exist_ok=True)
    (PROFILE / "package.json").write_text(
        json.dumps(PROFILE_PACKAGE, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    patch = PROFILE_PATCH_TEMPLATE.replace(
        "{disabled_rows}", _disabled_rows_yaml()
    ).replace("__AEH_E2E_ENTRY_URL__", AEH_ENTRY.as_uri())
    (PROFILE / "cordis.patch.yml").write_text(patch, encoding="utf-8")


def reset_isolated_state() -> None:
    """Drop prior session/storage state from the isolated home only.

    This keeps each acceptance run's evidence to exactly the sessions that run
    created. It never leaves `step18/home` (the running `~/.dsh` is untouched).
    """
    for name in ("sessions", "storages"):
        target = HOME / name
        if target.exists():
            shutil.rmtree(target)


def _redact(text: str) -> str:
    text = re.sub(r"hsurr:[A-Za-z0-9_\-]+", "[surrogate-redacted]", text)
    text = re.sub(r"sk-[A-Za-z0-9_\-]{6,}", "[key-redacted]", text)
    return text


def read_surrogate() -> str:
    """Fetch the Sidrune surrogate credential without printing it."""
    sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
    from dynamic_credentials import dynamic_credential_entry  # type: ignore

    entry = dynamic_credential_entry("custom.sidrune", "access_token")
    surrogate = entry.get("surrogate")
    if not isinstance(surrogate, str) or not surrogate:
        raise RuntimeError("custom.sidrune returned no surrogate credential")
    return surrogate


def _package_version(package: str) -> str | None:
    manifest = RUNTIME / "node_modules" / "@deepseek-ai" / package / "package.json"
    if not manifest.exists():
        return None
    return json.loads(manifest.read_text(encoding="utf-8")).get("version")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    digest.update(path.read_bytes())
    return digest.hexdigest()


def run_metadata(run_id: str) -> dict:
    return {
        "run_id": run_id,
        "started_at_utc": _dt.datetime.now(_dt.timezone.utc).isoformat(),
        "node": subprocess.run(
            ["node", "--version"], capture_output=True, text=True
        ).stdout.strip(),
        "isolated_dsh_home": str(HOME),
        "isolated_profile": PROFILE_NAME,
        "isolated_runtime": str(DSH_ENTRY),
        "synthetic_entry": str(AEH_ENTRY),
        "synthetic_entry_sha256": _sha256(AEH_ENTRY),
        "profile_patch_sha256": _sha256(PROFILE / "cordis.patch.yml"),
        "toolchain": {
            "dsh": _package_version("dsh"),
            "dsh-base": _package_version("dsh-base"),
            "dsh-headless": _package_version("dsh-headless"),
            "dsh-llm-pi-ai": _package_version("dsh-llm-pi-ai"),
            "dsh-tools": _package_version("dsh-tools"),
            "cordis": _package_version("cordis"),
        },
        "provider": "sidrune",
        "base_url": "https://sidrune.ai/v1",
        "model": "deepseek-v4-1-flash",
        "credential": "custom.sidrune hsurr surrogate via launch env; never written",
        "running_harness_touched": False,
    }


def child_env(with_credential: bool) -> dict:
    env = dict(os.environ)
    env["DSH_HOME"] = str(HOME)
    env["DSH_PROFILE"] = PROFILE_NAME
    env["DSH_PERMISSION_MODE"] = "read-only"
    env["DSH_TELEMETRY_DISABLED"] = "1"
    # Keep the isolated instance's npm cache local to the repo.
    env["npm_config_cache"] = str(STEP18 / ".npm-cache")
    if with_credential:
        env["SIDRUNE_API_KEY"] = read_surrogate()
    return env


def base_command(task: str, extra: list[str] | None = None) -> list[str]:
    command = [
        "node",
        str(DSH_ENTRY),
        "--profile",
        PROFILE_NAME,
        *(extra or []),
    ]
    if task:
        command.append(task)
    return command


def run_dump_config(env: dict) -> str:
    result = subprocess.run(
        ["node", str(DSH_ENTRY), "--profile", PROFILE_NAME, "--dump-config"],
        cwd=WORK,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=300,
    )
    return _redact(result.stdout + result.stderr)


def _decompress_zstd(path: Path) -> str:
    script = (
        "const fs=require('fs'),z=require('zlib');"
        "process.stdout.write("
        "z.zstdDecompressSync(fs.readFileSync(process.argv[1])).toString('utf8'))"
    )
    result = subprocess.run(
        ["node", "-e", script, str(path)],
        capture_output=True,
        timeout=120,
    )
    if result.returncode != 0:
        raise RuntimeError(
            "zstd decompress failed: "
            + result.stderr.decode("utf-8", errors="replace")[:400]
        )
    return result.stdout.decode("utf-8", errors="replace")


def copy_session_logs(dest: Path) -> list[str]:
    """Copy the isolated session store into the evidence directory.

    The durable log is zstd-compressed, so it is decompressed first and the
    plain JSONL is what reviewers read; redaction is applied to the decoded
    text. Non-text files are copied byte-for-byte.
    """
    root = HOME / "sessions"
    copied: list[str] = []
    if not root.exists():
        return copied
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(HOME)
        target = dest / "session-log" / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        if path.suffix == ".zstd":
            target = target.with_suffix("")
            target.write_text(
                _redact(_decompress_zstd(path)), encoding="utf-8"
            )
        else:
            data = path.read_bytes()
            try:
                text = data.decode("utf-8")
            except UnicodeDecodeError:
                target.write_bytes(data)
            else:
                target.write_text(_redact(text), encoding="utf-8")
        copied.append(str(rel))
    return copied


def summarize(stdout: str) -> dict:
    summary: dict = {
        "events": 0,
        "tool_calls": [],
        "tool_results": [],
        "texts": [],
        "final": None,
        "errors": [],
    }
    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        summary["events"] += 1
        kind = event.get("type")
        if kind == "tool_call":
            summary["tool_calls"].append(
                {
                    "tool": event.get("tool"),
                    "callId": event.get("callId"),
                    "input": event.get("input"),
                }
            )
        elif kind == "tool_result":
            result = event.get("result")
            rendered = (
                result
                if isinstance(result, str)
                else json.dumps(result, ensure_ascii=False)
            )
            summary["tool_results"].append(
                {
                    "callId": event.get("callId"),
                    "status": event.get("status"),
                    "result": rendered,
                }
            )
        elif kind == "text":
            summary["texts"].append(event.get("text"))
        elif kind == "final":
            summary["final"] = event.get("text") or event
        elif kind == "error":
            summary["errors"].append(event)
    return summary


def _highlights(tool: str, result_text: str) -> dict:
    try:
        parsed = json.loads(result_text)
    except (json.JSONDecodeError, TypeError):
        return {"raw": result_text[:200]}
    if not isinstance(parsed, dict):
        return {"raw": result_text[:200]}
    if tool == "aeh_check_curriculum":
        return {"allowed": parsed.get("allowed"), "reasons": parsed.get("reasons")}
    if tool == "aeh_update_hypotheses":
        state = parsed.get("state") or {}
        return {
            "hypotheses": len(state.get("hypotheses") or []),
            "snapshotRef": parsed.get("snapshotRef") or state.get("snapshotRef"),
        }
    if tool == "aeh_select_probe":
        selection = parsed.get("selection") or {}
        return {
            "itemId": selection.get("itemId"),
            "score": selection.get("score"),
            "skipped": parsed.get("skipped"),
        }
    if tool == "aeh_schedule_review":
        return {
            "nextIntervalDays": parsed.get("nextIntervalDays"),
            "stabilityDays": (parsed.get("state") or {}).get("stabilityDays"),
            "difficultyState": (parsed.get("state") or {}).get("difficultyState"),
        }
    if tool == "aeh_generate_report":
        totals = parsed.get("totals") or {}
        minimization = parsed.get("data_minimization") or {}
        return {
            "attempts": totals.get("attempts"),
            "independentCorrect": totals.get("independent_correct"),
            "excluded": minimization.get("source_events_excluded"),
        }
    return {}


def write_summary_md(dest: Path, summary: dict, metadata: dict) -> None:
    lines = [
        f"# Step 18 isolated end-to-end evidence — {metadata['run_id']}",
        "",
        "Synthetic session only. No real student data and no secret is present.",
        "",
        "## Isolation",
        "",
        f"- isolated `DSH_HOME`: `{metadata['isolated_dsh_home']}`",
        f"- isolated profile: `{metadata['isolated_profile']}`",
        f"- isolated runtime: `{metadata['isolated_runtime']}`",
        f"- synthetic entry: `{metadata['synthetic_entry']}`",
        f"- entry sha256: `{metadata['synthetic_entry_sha256']}`",
        "- running harness `~/.dsh`, its npx install, and the harness clone: **untouched**",
        "",
        "## Toolchain",
        "",
        "| package | version |",
        "|---|---|",
    ]
    for key, value in metadata["toolchain"].items():
        lines.append(f"| {key} | {value} |")
    lines += [
        "",
        f"- provider/model: `{metadata['provider']}` / `{metadata['model']}`",
        f"- Node: `{metadata['node']}`",
        "",
        "## Result",
        "",
        f"- exit code: `{(dest / 'exit-code.txt').read_text().strip()}`",
        f"- JSON events: {summary['events']}",
        f"- tool calls / results: {len(summary['tool_calls'])} / {len(summary['tool_results'])}",
        f"- error events: {len(summary['errors'])}",
        "",
        "## Tool calls",
        "",
        "| # | tool | input (truncated) | status | highlight |",
        "|---|---|---|---|---|",
    ]
    for index, (call, result) in enumerate(
        zip(summary["tool_calls"], summary["tool_results"]), start=1
    ):
        tool = call.get("tool") or "?"
        payload = json.dumps(call.get("input"), ensure_ascii=False)
        if len(payload) > 90:
            payload = payload[:87] + "..."
        highlight = json.dumps(
            _highlights(tool, result.get("result") or ""), ensure_ascii=False
        )
        lines.append(
            f"| {index} | `{tool}` | `{payload}` | {result.get('status')} | `{highlight}` |"
        )
    lines += [
        "",
        "## Final answer",
        "",
        "```text",
        summary.get("final") or "",
        "```",
        "",
        "## Evidence files",
        "",
        "- `command.txt` — exact command, cwd, environment (credential redacted)",
        "- `task.md` — the synthetic task text",
        "- `profile.package.json` / `profile.cordis.patch.yml` — composed isolated profile",
        "- `dump-config.txt` — `--dump-config` output proving the AEH row is composed",
        "- `stdout.jsonl` — newline-delimited run events, including full tool inputs/results",
        "- `stderr.log` — diagnostics (empty on success)",
        "- `summary.json` — machine-readable summary of the same events",
        "- `session-log/` — decompressed isolated session JSONL",
        "- `metadata.json` — versions and hashes",
        "",
    ]
    (dest / "summary.md").write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--task-file", type=Path)
    parser.add_argument("--timeout", type=int, default=1200)
    parser.add_argument("--run-id")
    args = parser.parse_args()

    if not DSH_ENTRY.exists():
        print(f"missing isolated dsh runtime: {DSH_ENTRY}", file=sys.stderr)
        return 2

    task = DEFAULT_TASK
    if args.task_file:
        task = args.task_file.read_text(encoding="utf-8")

    write_profile()
    WORK.mkdir(parents=True, exist_ok=True)

    print(f"[step18] isolated DSH_HOME : {HOME}")
    print(f"[step18] isolated profile   : {PROFILE}")
    print(f"[step18] isolated runtime   : {DSH_ENTRY}")
    print(f"[step18] synthetic entry    : {AEH_ENTRY}")

    if args.dry_run:
        env = child_env(with_credential=False)
        dump = run_dump_config(env)
        print(dump)
        return 0

    run_id = args.run_id or _dt.datetime.now(_dt.timezone.utc).strftime(
        "%Y%m%dT%H%M%SZ"
    )
    dest = EVIDENCE / run_id
    dest.mkdir(parents=True, exist_ok=True)

    # Clean only the isolated home so this run's session evidence is exact.
    reset_isolated_state()

    env = child_env(with_credential=True)
    command = base_command(task, extra=["--json"])

    # Record the composed profile and toolchain metadata before the run.
    (dest / "dump-config.txt").write_text(
        run_dump_config(child_env(with_credential=False)), encoding="utf-8"
    )
    (dest / "metadata.json").write_text(
        json.dumps(run_metadata(run_id), indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    result = subprocess.run(
        command,
        cwd=WORK,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=args.timeout,
    )

    stdout = _redact(result.stdout)
    stderr = _redact(result.stderr)
    summary = summarize(stdout)

    (dest / "command.txt").write_text(
        "cwd: {}\n".format(WORK)
        + "DSH_HOME={}\n".format(HOME)
        + "DSH_PROFILE={}\n".format(PROFILE_NAME)
        + "DSH_PERMISSION_MODE=read-only\n"
        + "SIDRUNE_API_KEY=[surrogate-redacted]\n"
        + " ".join(command)
        + "\n",
        encoding="utf-8",
    )
    (dest / "stdout.jsonl").write_text(stdout, encoding="utf-8")
    (dest / "stderr.log").write_text(stderr, encoding="utf-8")
    (dest / "exit-code.txt").write_text(f"{result.returncode}\n", encoding="utf-8")
    (dest / "task.md").write_text(task, encoding="utf-8")
    (dest / "summary.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    shutil.copy2(PROFILE / "package.json", dest / "profile.package.json")
    shutil.copy2(PROFILE / "cordis.patch.yml", dest / "profile.cordis.patch.yml")
    copied = copy_session_logs(dest)
    metadata = json.loads((dest / "metadata.json").read_text(encoding="utf-8"))
    write_summary_md(dest, summary, metadata)

    print(f"[step18] run id            : {run_id}")
    print(f"[step18] exit code         : {result.returncode}")
    print(f"[step18] json events       : {summary['events']}")
    print(f"[step18] tool calls        : {len(summary['tool_calls'])}")
    print(f"[step18] tool results      : {len(summary['tool_results'])}")
    print(f"[step18] session logs      : {len(copied)}")
    print(f"[step18] evidence          : {dest}")
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
