import { describe, expect, test } from "bun:test"

import runtimeContract from "../../eval/runtime-contract.json"

describe("task 1 scaffold", () => {
  test("freezes the local runtime contract", () => {
    expect(runtimeContract.opencodeVersion).toBe("1.14.29")
    expect(runtimeContract.nativeAgentDir).toBe("agent")
    expect(runtimeContract.pluginDir).toBe(".opencode/plugins")
    expect(runtimeContract.skillDir).toBe(".opencode/skills")
    expect(runtimeContract.commandDir).toBe(".opencode/commands")
  })

  test("exports a minimal loadable plugin", async () => {
    const { OCEvolverPlugin } = await import("../../src/oc-evolver.ts")
    const hooks = await OCEvolverPlugin({} as never)

    expect(hooks).toEqual({})
  })
})
