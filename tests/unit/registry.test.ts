import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import runtimeContract from "../../eval/runtime-contract.json"
import {
  applyMutationTransaction,
  loadRegistry,
  promotePendingRevision,
  rejectPendingRevision,
  rollbackLatestRevision,
  saveRegistry,
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
        memories: {},
        quarantine: {},
        currentRevision: null,
        pendingRevision: null,
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
      memories: {},
      quarantine: {},
      currentRevision: null,
      pendingRevision: null,
    })
  })

  test("returns an empty registry only when the registry file is missing", async () => {
    await rm(join(workspaceRoot, ".opencode/oc-evolver/registry.json"))

    expect(await loadRegistry(pluginFilePath, runtimeContract)).toEqual({
      skills: {},
      agents: {},
      commands: {},
      memories: {},
      quarantine: {},
      currentRevision: null,
      pendingRevision: null,
    })
  })

  test("surfaces malformed registry JSON instead of silently resetting state", async () => {
    await writeFile(join(workspaceRoot, ".opencode/oc-evolver/registry.json"), "{not valid json\n")

    await expect(loadRegistry(pluginFilePath, runtimeContract)).rejects.toThrow()
  })

  test("saveRegistry replaces the registry contents and cleans up temp files", async () => {
    await saveRegistry(pluginFilePath, runtimeContract, {
      skills: {},
      agents: {},
      commands: {
        review: {
          kind: "command",
          name: "review",
          nativePath: ".opencode/commands/review.md",
          revisionID: "revision-1",
          contentHash: "abc123",
        },
      },
      memories: {},
      quarantine: {},
      currentRevision: "revision-1",
      pendingRevision: null,
    })

    const savedRegistry = JSON.parse(
      await readFile(join(workspaceRoot, ".opencode/oc-evolver/registry.json"), "utf8"),
    )
    const registryRootEntries = await readdir(join(workspaceRoot, ".opencode/oc-evolver"))

    expect(savedRegistry).toMatchObject({
      commands: {
        review: {
          nativePath: ".opencode/commands/review.md",
          revisionID: "revision-1",
        },
      },
      currentRevision: "revision-1",
      pendingRevision: null,
    })
    expect(registryRootEntries.filter((entry) => entry.includes("registry.json.tmp-"))).toEqual([])
  })

  test("records a skill mutation as a pending revision snapshot", async () => {
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
    expect(result.registry.currentRevision).toBeNull()
    expect(result.registry.pendingRevision).toBe(result.revisionID)
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
    expect(revision.previousAcceptedRevisionID).toBeNull()

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

  test("records a memory mutation in registry metadata and a pending revision snapshot", async () => {
    const result = await applyMutationTransaction({
      pluginFilePath,
      runtimeContract,
      mutation: {
        kind: "memory",
        name: "project-preferences",
        document: `---
name: project-preferences
description: Shared project memory routing
storage_mode: memory-and-artifact
sources:
  - memory://memory/config/global
  - memory://plans/oc-evolver/*
queries:
  - oc-evolver memory profiles
---

Prefer Basic Memory notes over ad-hoc local docs when recording durable guidance.
`,
      },
    })

    expect(result.revisionID).toBeString()
    expect(result.registry.currentRevision).toBeNull()
    expect(result.registry.pendingRevision).toBe(result.revisionID)
    expect(result.registry.memories["project-preferences"]).toMatchObject({
      kind: "memory",
      name: "project-preferences",
      nativePath: ".opencode/memory/project-preferences.md",
      revisionID: result.revisionID,
    })
    expect(result.registry.memories["project-preferences"]?.contentHash).toMatch(/^[a-f0-9]{64}$/)

    const revision = JSON.parse(
      await readFile(
        join(workspaceRoot, `.opencode/oc-evolver/revisions/${result.revisionID}.json`),
        "utf8",
      ),
    )

    expect(revision.entries.memories["project-preferences"].document).toContain(
      "name: project-preferences",
    )
    expect(revision.entries.memories["project-preferences"].contentHash).toBe(
      result.registry.memories["project-preferences"]?.contentHash,
    )

    const auditLines = (
      await readFile(join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))

    expect(auditLines.at(-1)).toMatchObject({
      action: "write_memory",
      status: "success",
      revisionID: result.revisionID,
      target: ".opencode/memory/project-preferences.md",
    })
  })

  test("promotes and rejects pending revisions explicitly", async () => {
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

    const promoted = await promotePendingRevision(pluginFilePath, runtimeContract)

    expect(promoted.currentRevisionID).toBe(first.revisionID)
    expect(promoted.pendingRevisionID).toBeNull()
    expect((await loadRegistry(pluginFilePath, runtimeContract)).currentRevision).toBe(first.revisionID)

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

    const rejected = await rejectPendingRevision(pluginFilePath, runtimeContract)

    expect(rejected.rejectedRevisionID).toBe(second.revisionID)
    expect(rejected.restoredRevisionID).toBe(first.revisionID)
    expect((await loadRegistry(pluginFilePath, runtimeContract))).toMatchObject({
      currentRevision: first.revisionID,
      pendingRevision: null,
    })
    expect(
      await readFile(join(workspaceRoot, ".opencode/commands/review-markdown.md"), "utf8"),
    ).toContain("First review flow")
  })

  test("rolls back the latest accepted revision and removes additive artifacts", async () => {
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
    await promotePendingRevision(pluginFilePath, runtimeContract)

    const second = await applyMutationTransaction({
      pluginFilePath,
      runtimeContract,
      mutation: {
        kind: "command",
        name: "review-summary",
        document: `---
description: Summary review flow
---

Review SUMMARY.md.
`,
      },
    })
    await promotePendingRevision(pluginFilePath, runtimeContract)

    const rollback = await rollbackLatestRevision(pluginFilePath, runtimeContract)

    expect(rollback.currentRevisionID).toBe(first.revisionID)
    expect(rollback.rolledBackRevisionID).toBe(second.revisionID)
    expect(
      await readFile(join(workspaceRoot, ".opencode/commands/review-markdown.md"), "utf8"),
    ).toContain("First review flow")
    await expect(access(join(workspaceRoot, ".opencode/commands/review-summary.md"))).rejects.toBeDefined()

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
