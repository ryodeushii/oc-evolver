Turn 1:

The plugin should already have restored the persisted scheduled autonomous loop during startup before you act.

Call exactly `evolver_autonomous_status`.

Do not call any other tools.

Fail unless all of the following are true:
- the autonomous loop is enabled
- the autonomous loop is not paused
- `intervalMs` remains `60000`
- `verificationCommands` remains `[["bun", "run", "typecheck"]]`
- `evaluationScenarios` remains `["autonomous-run"]`

---

Turn 2:

Continue the same session.

Call exactly `evolver_status`.

Do not call any other tools.

Fail unless startup restoration produced durable `autonomous_restore` audit evidence and `evolver_status` reflects the current registry state.

If any check fails, report the failure instead of claiming success.
