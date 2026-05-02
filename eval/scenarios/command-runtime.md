Turn 1:

The harness already seeds an accepted `review-markdown` command plus accepted `session-routing` and `command-routing` memory profiles.
Use `evolver_run_command` directly.
Run `review-markdown` once against `README.md`.
The harness will verify that the successful command run leaves the continued session retaining the command-owned runtime policy and command memory state.
Stop after the command finishes.
