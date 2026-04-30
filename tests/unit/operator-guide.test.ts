import { describe, expect, test } from "bun:test"

async function loadOperatorGuideModule() {
  try {
    return await import("../../src/kernel/operator-guide.ts")
  } catch {
    return null
  }
}

describe("operator guide", () => {
  test("operator guide includes tool-routing and memory-routing rules", async () => {
    const operatorGuideModule = await loadOperatorGuideModule()

    expect(operatorGuideModule).toBeDefined()

    const buildOperatorGuide = operatorGuideModule?.buildOperatorGuide
    expect(typeof buildOperatorGuide).toBe("function")

    if (typeof buildOperatorGuide !== "function") {
      return
    }

    const guide = buildOperatorGuide()

    expect(guide).toContain("evolver_write_skill")
    expect(guide).toContain("evolver_apply_memory")
    expect(guide).toContain("evolver_rollback")
    expect(guide).toContain("Docs, specs, research")
    expect(guide).toContain("memory-only")
    expect(guide).toContain("artifact-only")
  })

  test("injects the operator guide only once per session", async () => {
    const operatorGuideModule = await loadOperatorGuideModule()

    expect(operatorGuideModule).toBeDefined()

    const ensureOperatorGuideForSession = operatorGuideModule?.ensureOperatorGuideForSession
    expect(typeof ensureOperatorGuideForSession).toBe("function")

    if (typeof ensureOperatorGuideForSession !== "function") {
      return
    }

    const prompts: unknown[] = []
    const client = {
      session: {
        prompt: async (payload: unknown) => {
          prompts.push(payload)
          return { info: {}, parts: [] }
        },
      },
    }

    await ensureOperatorGuideForSession({
      client,
      sessionID: "s1",
    })
    await ensureOperatorGuideForSession({
      client,
      sessionID: "s1",
    })

    expect(prompts).toHaveLength(1)
  })
})
