import { describe, expect, test } from "bun:test"

import {
  parseAgentDocument,
  parseCommandDocument,
  parseSkillDocument,
  validateSkillBundle,
} from "../../src/kernel/validate.ts"

describe("artifact validation", () => {
  test("rejects a skill document without required name and description", () => {
    expect(() => parseSkillDocument("# Missing frontmatter\n")).toThrow(
      /skill.+name.+description/i,
    )
  })

  test("parses a valid skill document", () => {
    expect(
      parseSkillDocument(`---
name: fixture-refactor
description: Rewrite TODO markers in markdown files
---

## What I do

- Rewrite TODO to NOTE
`),
    ).toMatchObject({
      frontmatter: {
        name: "fixture-refactor",
        description: "Rewrite TODO markers in markdown files",
      },
      body: expect.stringContaining("What I do"),
    })
  })

  test("rejects helper files outside the skill bundle root", () => {
    expect(() =>
      validateSkillBundle({
        rootDirName: "fixture-refactor",
        skillDocument: `---
name: fixture-refactor
description: Rewrite TODO markers in markdown files
---

Use the helper.
`,
        helperFiles: [
          {
            relativePath: "../escape.py",
            content: "print('nope')\n",
          },
        ],
      }),
    ).toThrow(/helper file path.+skill bundle/i)
  })

  test("parses a valid agent document with permission fields", () => {
    expect(
      parseAgentDocument(`---
description: Review markdown changes
mode: subagent
model: anthropic/claude-sonnet-4-20250514
permission:
  edit: deny
  bash: ask
---

Review markdown changes before they land.
`),
    ).toMatchObject({
      frontmatter: {
        description: "Review markdown changes",
        mode: "subagent",
        model: "anthropic/claude-sonnet-4-20250514",
        permission: {
          edit: "deny",
          bash: "ask",
        },
      },
      body: expect.stringContaining("Review markdown changes"),
    })
  })

  test("rejects an agent document with an invalid mode", () => {
    expect(() =>
      parseAgentDocument(`---
description: Review markdown changes
mode: worker
---

Review markdown changes before they land.
`),
    ).toThrow(/agent.+mode/i)
  })

  test("parses a valid command document with optional agent binding", () => {
    expect(
      parseCommandDocument(`---
description: Run markdown review
agent: fixture-reviewer
model: anthropic/claude-sonnet-4-20250514
---

Review README.md and summarize changes.
`),
    ).toMatchObject({
      frontmatter: {
        description: "Run markdown review",
        agent: "fixture-reviewer",
        model: "anthropic/claude-sonnet-4-20250514",
      },
      body: expect.stringContaining("Review README.md"),
    })
  })

  test("rejects a command document without a description", () => {
    expect(() =>
      parseCommandDocument(`---
agent: fixture-reviewer
---

Review README.md and summarize changes.
`),
    ).toThrow(/command.+description/i)
  })
})
