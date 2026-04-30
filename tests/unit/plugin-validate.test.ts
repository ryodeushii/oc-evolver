import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
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
          memories: {},
          quarantine: {},
          currentRevision: null,
          pendingRevision: null,
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

  test("evolver_validate detects registry integrity drift and broken references", async () => {
    const skillDocument = `---
name: tracked-skill
description: Rewrite TODO markers
---

Use the helper.
`
    const agentDocument = `---
description: Review markdown changes
mode: subagent
memory:
  - missing-memory
---

Review markdown changes before they land.
`
    const commandDocument = `---
description: Run markdown review
agent: missing-agent
---

Review README.md.
`
    const memoryDocument = `---
name: project-memory
description: Shared guidance
---

Prefer durable notes.
`

    await mkdir(join(workspaceRoot, ".opencode/skills/tracked-skill"), { recursive: true })
    await mkdir(join(workspaceRoot, ".opencode/agent"), { recursive: true })
    await mkdir(join(workspaceRoot, ".opencode/commands"), { recursive: true })
    await mkdir(join(workspaceRoot, ".opencode/memory"), { recursive: true })
    await writeFile(join(workspaceRoot, ".opencode/skills/tracked-skill/SKILL.md"), skillDocument)
    await writeFile(join(workspaceRoot, ".opencode/agent/reviewer.md"), agentDocument)
    await writeFile(join(workspaceRoot, ".opencode/commands/review-markdown.md"), commandDocument)
    await writeFile(join(workspaceRoot, ".opencode/memory/project-memory.md"), memoryDocument)
    await writeFile(
      join(workspaceRoot, ".opencode/oc-evolver/registry.json"),
      JSON.stringify(
        {
          skills: {
            "tracked-skill": {
              kind: "skill",
              name: "tracked-skill",
              nativePath: ".opencode/skills/tracked-skill/SKILL.md",
              helperPaths: [".opencode/skills/tracked-skill/scripts/rewrite.py"],
              revisionID: "rev-skill",
              contentHash: "0".repeat(64),
            },
          },
          agents: {
            reviewer: {
              kind: "agent",
              name: "reviewer",
              nativePath: ".opencode/agent/reviewer.md",
              revisionID: "rev-agent",
              contentHash: createHash("sha256").update(agentDocument).digest("hex"),
            },
          },
          commands: {
            "review-markdown": {
              kind: "command",
              name: "review-markdown",
              nativePath: ".opencode/commands/review-markdown.md",
              revisionID: "rev-command",
              contentHash: createHash("sha256").update(commandDocument).digest("hex"),
            },
          },
          memories: {
            "project-memory": {
              kind: "memory",
              name: "project-memory",
              nativePath: ".opencode/memory/project-memory.md",
              revisionID: "rev-memory",
              contentHash: "f".repeat(64),
            },
          },
          quarantine: {},
          currentRevision: null,
          pendingRevision: null,
        },
        null,
        2,
      ),
    )

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
        sessionID: "session-integrity-validate",
        messageID: "message-integrity-validate",
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

    expect(summary.invalid).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: ".opencode/skills/tracked-skill/SKILL.md",
          kind: "skill",
          reason: expect.stringMatching(/missing helper file/i),
        }),
        expect.objectContaining({
          target: ".opencode/agent/reviewer.md",
          kind: "agent",
          reason: expect.stringMatching(/unknown memory profile/i),
        }),
        expect.objectContaining({
          target: ".opencode/commands/review-markdown.md",
          kind: "command",
          reason: expect.stringMatching(/unknown agent/i),
        }),
        expect.objectContaining({
          target: ".opencode/memory/project-memory.md",
          kind: "memory",
          reason: expect.stringMatching(/content hash mismatch/i),
        }),
      ]),
    )
  })

  test("evolver_check reports pending revisions and invalid artifacts", async () => {
    await writeFile(
      join(workspaceRoot, ".opencode/oc-evolver/registry.json"),
      JSON.stringify(
        {
          skills: {},
          agents: {},
          commands: {},
          memories: {},
          quarantine: {},
          currentRevision: "rev-accepted",
          pendingRevision: "rev-pending",
        },
        null,
        2,
      ),
    )

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

    const output = await hooks.tool?.evolver_check?.execute(
      {},
      {
        sessionID: "session-check",
        messageID: "message-check",
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
      ok: boolean
      currentRevision: string | null
      pendingRevision: string | null
      invalid: Array<{ target: string }>
    }
    const auditLines = (
      await readFile(join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))

    expect(summary).toMatchObject({
      ok: false,
      currentRevision: "rev-accepted",
      pendingRevision: "rev-pending",
    })
    expect(summary.invalid).toEqual([
      expect.objectContaining({
        target: ".opencode/skills/broken-skill/SKILL.md",
      }),
    ])
    expect(auditLines.at(-1)).toMatchObject({
      action: "check",
      status: "failure",
    })
  })
})
