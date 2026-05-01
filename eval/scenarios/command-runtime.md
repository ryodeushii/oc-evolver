Use the oc-evolver plugin to exercise command-owned runtime metadata end to end.
Create a reusable memory profile named `session-routing` first.
Create a second reusable memory profile named `command-routing`.
Apply only `session-routing` in the current session.
Create a command named `review-markdown` that carries its own `model`, `memory: [command-routing]`, and `permission` metadata.
Run that command once against `README.md`.
Call exactly `evolver_write_memory`, `evolver_write_memory`, `evolver_apply_memory`, `evolver_write_command`, and `evolver_run_command` in that order.
Stop after the command has run.
