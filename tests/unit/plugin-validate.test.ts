import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { OCEvolverPlugin } from "../../src/oc-evolver.ts"

describe("plugin validation tool", () => {
  let workspaceRoot: string

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "oc-evolver-plugin-validate-"))

    await mkdir(join(workspaceRoot, ".opencode/plugins"), { recursive: true })
    await mkdir(join(workspaceRoot, ".opencode/oc-evolver"), { recursive: true })
    await mkdir(join(workspaceRoot, ".opencode/skills/broken-skill"), { recursive: true })

    await writeFile(
      join(workspaceRoot, ".opencode/plugins/oc-evolver.ts"),
      "export const plugin = true\n",
    )
    await writeFile(
      join(workspaceRoot, ".opencode/oc-evolver/registry.json"),
      JSON.stringify(
        {
          skills: {},
          agents: {},
          commands: {},
          quarantine: {},
          currentRevision: null,
        },
        null,
        2,
      ),
    )
    await writeFile(
      join(workspaceRoot, ".opencode/skills/broken-skill/SKILL.md"),
      "---\nname: broken-skill\n---\n\nMissing description.\n",
    )
  })

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true })
  })

  test("evolver_validate can scan mutable roots and quarantine invalid artifacts", async () => {
    const hooks = await OCEvolverPlugin({
      client: {
        session: {
          prompt: async () => ({ info: {}, parts: [] }),
        },
      },
      project: {
        id: "fixture-project",
        worktree: "/",
      },
      directory: workspaceRoot,
      worktree: "/",
      experimental_workspace: {
        register() {},
      },
      serverUrl: new URL("http://localhost:4096"),
      $: {} as never,
    } as never)

    const output = await hooks.tool?.evolver_validate?.execute(
      {
        scope: "registry",
      } as never,
      {
        sessionID: "session-validate",
        messageID: "message-validate",
        agent: "main",
        directory: workspaceRoot,
        worktree: workspaceRoot,
        abort: new AbortController().signal,
        metadata() {},
        ask() {
          throw new Error("not implemented")
        },
      },
    )
    const summary = JSON.parse(String(output)) as {
      invalid: Array<{ target: string; kind: string; reason: string }>
    }
    const registry = JSON.parse(
      await readFile(join(workspaceRoot, ".opencode/oc-evolver/registry.json"), "utf8"),
    ) as {
      quarantine: Record<string, { kind: string; reason: string; failureClass: string }>
    }
    const auditLines = (
      await readFile(join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))

    expect(summary.invalid).toEqual([
      expect.objectContaining({
        target: ".opencode/skills/broken-skill/SKILL.md",
        kind: "skill",
      }),
    ])
    expect(registry.quarantine[".opencode/skills/broken-skill/SKILL.md"]).toMatchObject({
      kind: "skill",
      failureClass: "invalid_artifact",
    })
    expect(auditLines.at(-1)).toMatchObject({
      action: "validate",
      status: "failure",
      failureClass: "invalid_artifact",
      target: ".opencode/skills/broken-skill/SKILL.md",
    })
  })
})
