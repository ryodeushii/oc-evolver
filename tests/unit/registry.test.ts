import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import runtimeContract from "../../eval/runtime-contract.json"
import {
  applyMutationTransaction,
  loadRegistry,
  rollbackLatestRevision,
} from "../../src/kernel/registry.ts"

describe("registry transactions", () => {
  let workspaceRoot: string
  let pluginFilePath: string

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "oc-evolver-registry-"))
    pluginFilePath = join(workspaceRoot, ".opencode/plugins/oc-evolver.ts")

    await mkdir(join(workspaceRoot, ".opencode/plugins"), { recursive: true })
    await mkdir(join(workspaceRoot, ".opencode/oc-evolver"), { recursive: true })
    await writeFile(pluginFilePath, "export const plugin = true\n")
    await writeFile(
      join(workspaceRoot, ".opencode/oc-evolver/registry.json"),
      JSON.stringify({
        skills: {},
        agents: {},
        commands: {},
        currentRevision: null,
      }, null, 2),
    )
  })

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true })
  })

  test("loads the registry from plugin-owned metadata", async () => {
    expect(await loadRegistry(pluginFilePath, runtimeContract)).toEqual({
      skills: {},
      agents: {},
      commands: {},
      currentRevision: null,
    })
  })

  test("records a skill mutation in registry metadata and a revision snapshot", async () => {
    const result = await applyMutationTransaction({
      pluginFilePath,
      runtimeContract,
      mutation: {
        kind: "skill",
        name: "fixture-refactor",
        document: `---
name: fixture-refactor
description: Rewrite TODO markers in markdown files
---

Use the helper.
`,
        helperFiles: [
          {
            relativePath: "scripts/rewrite.py",
            content: "print('rewrite')\n",
          },
        ],
      },
    })

    expect(result.revisionID).toBeString()
    expect(result.registry.currentRevision).toBe(result.revisionID)
    expect(result.registry.skills["fixture-refactor"]).toMatchObject({
      kind: "skill",
      name: "fixture-refactor",
      nativePath: ".opencode/skills/fixture-refactor/SKILL.md",
      revisionID: result.revisionID,
      helperPaths: [".opencode/skills/fixture-refactor/scripts/rewrite.py"],
    })
    expect(result.registry.skills["fixture-refactor"]?.contentHash).toMatch(/^[a-f0-9]{64}$/)

    const revision = JSON.parse(
      await readFile(
        join(workspaceRoot, `.opencode/oc-evolver/revisions/${result.revisionID}.json`),
        "utf8",
      ),
    )

    expect(revision.entries.skills["fixture-refactor"].document).toContain("name: fixture-refactor")
    expect(revision.entries.skills["fixture-refactor"].contentHash).toBe(
      result.registry.skills["fixture-refactor"]?.contentHash,
    )
    expect(revision.previousRevisionID).toBeNull()

    const auditLines = (
      await readFile(join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))

    expect(auditLines.at(-1)).toMatchObject({
      action: "write_skill",
      status: "success",
      revisionID: result.revisionID,
      target: ".opencode/skills/fixture-refactor/SKILL.md",
    })
  })

  test("rolls back the latest accepted revision", async () => {
    const first = await applyMutationTransaction({
      pluginFilePath,
      runtimeContract,
      mutation: {
        kind: "command",
        name: "review-markdown",
        document: `---
description: First review flow
---

Review README.md.
`,
      },
    })

    const second = await applyMutationTransaction({
      pluginFilePath,
      runtimeContract,
      mutation: {
        kind: "command",
        name: "review-markdown",
        document: `---
description: Second review flow
---

Review README.md twice.
`,
      },
    })

    const rollback = await rollbackLatestRevision(pluginFilePath, runtimeContract)

    expect(rollback.currentRevisionID).toBe(first.revisionID)
    expect(rollback.rolledBackRevisionID).toBe(second.revisionID)
    expect(
      await readFile(join(workspaceRoot, ".opencode/commands/review-markdown.md"), "utf8"),
    ).toContain("First review flow")

    const auditLines = (
      await readFile(join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))

    expect(auditLines.at(-1)).toMatchObject({
      action: "rollback",
      status: "success",
      revisionID: first.revisionID,
      rolledBackRevisionID: second.revisionID,
    })
  })
})
