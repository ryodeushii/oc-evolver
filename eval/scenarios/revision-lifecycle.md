Turn 1:

Use the oc-evolver plugin to exercise the pending revision review path.
Create a command named `review-markdown` and promote it.
Delete that command into a pending revision.
Inspect the pending revision with `evolver_review_pending`.
Call exactly `evolver_write_command`, `evolver_promote`, `evolver_delete_artifact`, and `evolver_review_pending`.

---

Turn 2:

Reject the pending deletion so the accepted command is restored.
Prune unreachable revision snapshots.
Call exactly `evolver_reject` and then `evolver_prune`.
Stop after prune succeeds.
