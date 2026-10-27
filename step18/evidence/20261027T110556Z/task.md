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
