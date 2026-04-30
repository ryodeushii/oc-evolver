import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { tmpdir } from "node:os"

import runtimeContract from "../../eval/runtime-contract.json"
import {
  materializeAgentDocument,
  materializeCommandDocument,
  materializeSkillBundle,
} from "../../src/kernel/materialize.ts"

describe("artifact materialization", () => {
  let workspaceRoot: string
  let pluginFilePath: string

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "oc-evolver-materialize-"))
    pluginFilePath = join(workspaceRoot, ".opencode/plugins/oc-evolver.ts")

    await mkdir(join(workspaceRoot, ".opencode/plugins"), { recursive: true })
    await writeFile(pluginFilePath, "export const plugin = true\n")
  })

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true })
  })

  test("materializes a validated skill bundle under the native skills root", async () => {
    const result = await materializeSkillBundle({
      pluginFilePath,
      runtimeContract,
      bundle: {
        rootDirName: "fixture-refactor",
        skillDocument: `---
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

    expect(result.bundleRootPath).toBe(
      join(workspaceRoot, ".opencode/skills/fixture-refactor"),
    )
    expect(result.writtenPaths).toEqual([
      join(workspaceRoot, ".opencode/skills/fixture-refactor/SKILL.md"),
      join(workspaceRoot, ".opencode/skills/fixture-refactor/scripts/rewrite.py"),
    ])
    expect(
      await readFile(join(result.bundleRootPath, "SKILL.md"), "utf8"),
    ).toContain("name: fixture-refactor")
  })

  test("materializes agents under the runtime-configured native agent dir", async () => {
    const result = await materializeAgentDocument({
      pluginFilePath,
      runtimeContract,
      agentName: "fixture-reviewer",
      document: `---
description: Review markdown changes
mode: subagent
permission:
  edit: deny
---

Review markdown changes before they land.
`,
    })

    expect(result.filePath).toBe(join(workspaceRoot, ".opencode/agent/fixture-reviewer.md"))
    expect(await readFile(result.filePath, "utf8")).toContain("mode: subagent")
  })

  test("materializes commands under the native commands root", async () => {
    const result = await materializeCommandDocument({
      pluginFilePath,
      runtimeContract,
      commandName: "review-markdown",
      document: `---
description: Run markdown review
agent: fixture-reviewer
---

Review README.md and summarize changes.
`,
    })

    expect(result.filePath).toBe(join(workspaceRoot, ".opencode/commands/review-markdown.md"))
    expect(await readFile(result.filePath, "utf8")).toContain("description: Run markdown review")
  })

  test("does not write any native skill files when validation fails", async () => {
    await expect(
      materializeSkillBundle({
        pluginFilePath,
        runtimeContract,
        bundle: {
          rootDirName: "fixture-refactor",
          skillDocument: `---
name: fixture-refactor
---

Missing description.
`,
          helperFiles: [
            {
              relativePath: "scripts/rewrite.py",
              content: "print('rewrite')\n",
            },
          ],
        },
      }),
    ).rejects.toThrow(/skill.+description/i)

    await expect(
      readFile(join(workspaceRoot, ".opencode/skills/fixture-refactor/SKILL.md"), "utf8"),
    ).rejects.toThrow()
  })

  test("cleans up temp files when a native write fails", async () => {
    const blockedRoot = join(workspaceRoot, ".opencode/commands")
    await writeFile(blockedRoot, "not a directory\n")

    await expect(
      materializeCommandDocument({
        pluginFilePath,
        runtimeContract,
        commandName: "review-markdown",
        document: `---
description: Run markdown review
---

Review README.md and summarize changes.
`,
      }),
    ).rejects.toThrow()

    expect(await readFile(pluginFilePath, "utf8")).toContain("export const plugin = true")
    const opencodeEntries = await Array.fromAsync(new Bun.Glob("**/*").scan({
      cwd: join(workspaceRoot, ".opencode"),
      onlyFiles: true,
      absolute: true,
    }))

    expect(opencodeEntries.filter((entry) => basename(entry).includes(".tmp-"))).toEqual([])
  })
})
