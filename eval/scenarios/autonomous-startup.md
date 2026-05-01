Turn 1:

The plugin should already have restored the persisted scheduled autonomous loop during startup before you act.

Use these exact tool calls in order.

1. Call `evolver_autonomous_status`.
2. Call `evolver_status`.

Do not call any other tools.

Fail unless all of the following are true:
- the autonomous loop is enabled
- the autonomous loop is not paused
- `intervalMs` remains `60000`
- `verificationCommands` remains `[["bun", "run", "typecheck"]]`
- `evaluationScenarios` remains `["autonomous-run"]`
- startup restoration produced durable `autonomous_restore` audit evidence

If any check fails, report the failure instead of claiming success.
