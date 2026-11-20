# Intent

Decide whether this exact candidate does what the user asked, observed as the user would experience it.

Ask: what observation or counterexample could change the verdict? Choose the smallest useful check, observe, adapt. An existing focused test, a direct CLI run, a terminal session (`observe_terminal`), or a local server (`start_service`) with a browser tool already installed may suffice. Keep screenshots or transcripts with `save_artifact` when they explain the outcome.

Use only trusted local commands in this checkout. Do not edit tracked files, write validation scripts into the product, install anything, or use live accounts.

A build or a green unrelated test alone is not proof. `pass` when your observations suffice; `fail` for an observed mismatch; `inconclusive` when you could not establish the result; `plan-fault` when the candidate faithfully follows an attached plan that cannot meet the request (name the plan decision in the witness). Say what you tried and what you saw.
