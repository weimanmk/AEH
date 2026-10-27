# Step 18 isolated end-to-end evidence — 20261027T110556Z

Synthetic session only. No real student data and no secret is present.

## Isolation

- isolated `DSH_HOME`: `/home/hatch/workspace/AEH/step18/home`
- isolated profile: `aeh-e2e`
- isolated runtime: `/home/hatch/workspace/AEH/step18/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js`
- synthetic entry: `/home/hatch/workspace/AEH/dsh-plugin/e2e/aeh-e2e-entry.ts`
- entry sha256: `e4709fda940e30c376d37ce0701cd60c937066b4a67440a9677883ce2fc00534`
- running harness `~/.dsh`, its npx install, and the harness clone: **untouched**

## Toolchain

| package | version |
|---|---|
| dsh | 0.2.1-rc.3 |
| dsh-base | 0.2.1-rc.3 |
| dsh-headless | 0.2.1-rc.3 |
| dsh-llm-pi-ai | 0.2.1-rc.3 |
| dsh-tools | 0.2.1-rc.3 |
| cordis | 4.0.5 |

- provider/model: `sidrune` / `deepseek-v4-1-flash`
- Node: `v24.22.1`

## Result

- exit code: `0`
- JSON events: 39
- tool calls / results: 6 / 6
- error events: 0

## Tool calls

| # | tool | input (truncated) | status | highlight |
|---|---|---|---|---|
| 1 | `aeh_check_curriculum` | `{"mode": "learn", "itemId": "item.fraction.add.001", "studentRef": "synthetic.student.s...` | completed | `{"allowed": true, "reasons": []}` |
| 2 | `aeh_check_curriculum` | `{"mode": "learn", "itemId": "item.fraction.multiply.001", "studentRef": "synthetic.stud...` | completed | `{"allowed": false, "reasons": ["kcs_not_allowed:kc.fraction.multiply"]}` |
| 3 | `aeh_update_hypotheses` | `{"operation": "spawn", "state": {"hypotheses": [], "unknownWeight": 0.5}, "hypothesis":...` | completed | `{"hypotheses": 1, "snapshotRef": "hyp_1"}` |
| 4 | `aeh_select_probe` | `{"mode": "learn", "studentRef": "synthetic.student.step18", "weights": {"hyp.adds_ok": ...` | completed | `{"itemId": "item.fraction.equiv.001", "score": -0.2953027976057393, "skipped": false}` |
| 5 | `aeh_schedule_review` | `{"state": {"learnerRef": "synthetic.student.step18", "memoryUnitId": "kc.fraction.add",...` | completed | `{"nextIntervalDays": 3.2, "stabilityDays": 3.2, "difficultyState": 4.8}` |
| 6 | `aeh_generate_report` | `{"audience": "teacher", "studentRef": "synthetic.student.step18", "windowStart": "2026-...` | completed | `{"attempts": 4, "independentCorrect": 3, "excluded": 0}` |

## Final answer

```text
All four stages executed. Final summary:

**Gate decisions (Stage A)**
- `item.fraction.add.001` → **allowed** (learn mode; permitted KCs include kc.fraction.add, kc.fraction.compare, kc.fraction.equiv, kc.place.value).
- `item.fraction.multiply.001` → **refused** by the fail-closed gate: `kcs_not_allowed:kc.fraction.multiply`.

**Selected probe (Stage B)**
- B1 spawned hypothesis `hyp.adds_ok` (normalised to weight 1, unknown 0).
- B2 selected **`item.fraction.equiv.001`** (score −0.2953; gate-allowed; required KC kc.fraction.equiv). Candidate `item.fraction.compare.001` was not selected; no rejects.

**Review interval (Stage C)**
- Memory unit `kc.fraction.add`, independent success applied → stability 3.2 days, difficulty 4.8, **nextIntervalDays = 3.2** (target retention 0.9, expected retrievability at next review 0.9).

**Report attempt totals (Stage D, teacher, minimized)**
- Attempts **4**, independent correct **3**, hinted correct 0, hints requested **1**, minutes **10**; independent accuracy 0.75, hints/attempt 0.25. 1 source event used, 0 excluded; no source refs emitted. Topic `kc.fraction.add`; no attention topics.

Notes: the report is an aggregate boundary — it contains only minimized totals/topic ids, no raw questions, answers, or event refs. The B1 spawn collapsed the unknown bucket to 0 (weight normalisation within the session snapshot only), and the review result is pure computation with no persisted write.
```

## Evidence files

- `command.txt` — exact command, cwd, environment (credential redacted)
- `task.md` — the synthetic task text
- `profile.package.json` / `profile.cordis.patch.yml` — composed isolated profile
- `dump-config.txt` — `--dump-config` output proving the AEH row is composed
- `stdout.jsonl` — newline-delimited run events, including full tool inputs/results
- `stderr.log` — diagnostics (empty on success)
- `summary.json` — machine-readable summary of the same events
- `session-log/` — decompressed isolated session JSONL
- `metadata.json` — versions and hashes
