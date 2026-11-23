# Worq inspector

The editor glance shows up to two live owners, or actionable failed owners, plus an overflow count. Live blockers come first; failed owners needing Main remain visible even with no live owners. `/worq-inspect [ref]` opens the read-only inspector even when Worq tools are off. Tab changes views; arrows choose a role; Enter focuses details so arrows scroll; Escape returns to the roster or closes. Wide terminals show both panes. Select an owner for its activity timeline including PQs and reviewers, or select a child to isolate its timeline. `/worq list [ref]` remains the legacy detailed surface, including outside TUI mode.

Evidence is session-only: up to 20 settled rounds independently of the activity ring, plus current live revisions. Plan identity is a digest of the submitted UTF-8 markdown and execute identity is the reviewed Git SHA, both scoped to the run and round. A review roster pass is not authorization to merge. The inspector does not observe merges or external plan writes. It does not copy finding text or paths; older rounds without a matching legacy record say historical prose is unavailable. Existing transcript notices retain their legacy text and expand/collapse access.

Context is the child SDK's estimate, not Main's context. Cache totals cover finalized successful/non-aborted assistant responses in that child session, with separate SDK field-availability counts for read and write. Values are SDK-normalized; zero can be a default, not a provider observation. Token rate is intentionally absent: a provider-specific matching token count and timing window have not been validated.

There are no graphs, animations, or cross-session telemetry. Consider role activity lanes first only if operators still struggle to reconstruct parallel work or waiting time using the Activity timeline. Sparklines and cross-session history remain deferred.

Offline Linux native smoke: `WORQ_NATIVE_INSPECTOR=1 node --experimental-strip-types --test test/inspector-native.test.ts`. The fixture uses a short temporary state path and clean Pi configuration. Its dummy API key enables model selection only; it sends no model prompts.
