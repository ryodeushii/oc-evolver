import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import runtimeContract from "../../eval/runtime-contract.json"
import { appendAuditEvent, recordPolicyDeniedEvent } from "../../src/kernel/audit.ts"

describe("audit log", () => {
  let workspaceRoot: string
  let pluginFilePath: string

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "oc-evolver-audit-"))
    pluginFilePath = join(workspaceRoot, ".opencode/plugins/oc-evolver.ts")

    await mkdir(join(workspaceRoot, ".opencode/plugins"), { recursive: true })
    await mkdir(join(workspaceRoot, ".opencode/oc-evolver"), { recursive: true })
    await writeFile(pluginFilePath, "export const plugin = true\n")
  })

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true })
  })

  test("appends structured audit events to plugin-owned ndjson", async () => {
    await appendAuditEvent({
      pluginFilePath,
      runtimeContract,
      event: {
        action: "write_skill",
        status: "success",
        target: ".opencode/skills/fixture-refactor/SKILL.md",
        detail: "validated and materialized",
      },
    })

    const lines = (await readFile(join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))

    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      action: "write_skill",
      status: "success",
      target: ".opencode/skills/fixture-refactor/SKILL.md",
      detail: "validated and materialized",
    })
    expect(lines[0].timestamp).toBeString()
  })

  test("records policy denial events with failure class", async () => {
    await recordPolicyDeniedEvent({
      pluginFilePath,
      runtimeContract,
      target: ".opencode/plugins/oc-evolver.ts",
      detail: "autonomous write denied: protected path",
    })

    const lines = (await readFile(join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))

    expect(lines[0]).toMatchObject({
      action: "policy_denied",
      status: "failure",
      failureClass: "policy_denied",
      target: ".opencode/plugins/oc-evolver.ts",
    })
  })
})
