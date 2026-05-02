Turn 1:

Use the oc-evolver plugin to exercise the pending revision review path.
Create a command named `review-markdown`.
Call exactly `evolver_write_command`.
Exit successfully after the write succeeds.

---

Turn 2:

Continue the same session.

Promote the pending command revision.
Call exactly `evolver_promote`.
Exit successfully after promote succeeds.

---

Turn 3:

Continue the same session.

Delete `review-markdown` into a pending revision.
Call exactly `evolver_delete_artifact`.
Exit successfully after the delete succeeds.

---

Turn 4:

Continue the same session.

Inspect the pending revision.
Call exactly `evolver_review_pending`.
Exit successfully after the review completes.

---

Turn 5:

Continue the same session.

Reject the pending deletion so the accepted command is restored.
Call exactly `evolver_reject`.
Exit successfully after reject succeeds.

---

Turn 6:

Continue the same session.

Prune unreachable revision snapshots.
Call exactly `evolver_prune`.
Stop after prune succeeds.
