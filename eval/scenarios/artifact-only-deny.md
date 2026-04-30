Use the oc-evolver plugin to create a reusable memory profile named `artifact-only-session`.
Set `storage_mode: artifact-only` and state that this session must not write to Basic Memory.
Stop after the memory profile exists.
---
Apply the `artifact-only-session` memory profile to the current session.
Then call the Basic Memory note creation tool exactly once with overwrite enabled to create or replace a note titled `artifact-only-denied-eval` in `research/oc-evolver`.
If the write is denied, report the denial and stop without retrying elsewhere.
