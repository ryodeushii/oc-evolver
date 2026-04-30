import { promises as fs } from "node:fs"
import path from "node:path"
import { tool, type Plugin } from "@opencode-ai/plugin"

type SessionStorageMode = "memory-only" | "artifact-only" | "memory-and-artifact"

type SessionEventType =
  | "blocked-local-memory-write"
  | "blocked-memory-write"
  | "memory-write"
  | "memory-worthy"
  | "policy-change"
  | "warning"
  | "error"

interface SessionEvent {
  type: SessionEventType
  label: string
  detail: string
  timestamp: number
}

interface LegacyBasicMemoryDirectoryRule {
  pattern: RegExp
  legacyLabel: string
  recommended: string
  reason: string
}

interface ProjectScopedDirectoryViolation {
  directory: string
  recommended: string
  reason: string
}

export type PreferenceScope = "global" | "project"

export interface PreferenceCandidate {
  id: string
  source: string
  scope: PreferenceScope
  text: string
  headingPath: string[]
  tokens: string[]
  baselineScore: number
}

export interface PreferenceRecall {
  baseline: PreferenceCandidate[]
  relevant: PreferenceCandidate[]
}

interface ExtractPreferenceCandidateOptions {
  scope: PreferenceScope
  source: string
}

interface CachedPreferenceNote {
  mtimeMs: number
  candidates: PreferenceCandidate[]
}

interface QueuedPreferenceRecall {
  queryText: string
  projectSlug?: string
  formattedText: string
}

interface ResolvedPreferenceRecall {
  queryText: string
  projectSlug?: string
  sources: string[]
  recall: PreferenceRecall
  formattedText: string
}

interface SessionState {
  sessionID: string
  createdAt: number
  updatedAt: number
  storageMode: SessionStorageMode
  lastUserText?: string
  queuedPreferenceRecall?: QueuedPreferenceRecall
  lastStatus?: string
  idleCount: number
  hadError: boolean
  sawDiff: boolean
  events: SessionEvent[]
  pendingMemoryCandidates: string[]
}

const sessionStates = new Map<string, SessionState>()
const DEFAULT_STORAGE_MODE: SessionStorageMode = "memory-only"
const PREFERENCE_BASELINE_LIMIT = 3
const PREFERENCE_RELEVANT_LIMIT = 3
const noteCache = new Map<string, CachedPreferenceNote>()
let basicMemoryProjectPathPromise: Promise<string | undefined> | undefined

const CANONICAL_BASIC_MEMORY_STRUCTURE = `Canonical Basic Memory structure:
- projects/<project-slug>/ -> project home, index, and reference notes
- specs/<project-slug>/ -> canonical specifications and contracts
- research/<project-slug>/ -> research syntheses and supporting findings
- plans/<project-slug>/ -> implementation plans and roadmaps
- tasks/<project-slug>/ -> active or pending project tasks
- tasks/<project-slug>/archive/ -> retired or superseded project tasks
- memory/config/global.md -> cross-project long-term memory and the successor to the old catch-all MEMORY.md
- memory/config/<project-slug>.md -> project memory rules, conventions, and routing notes
- memory/decisions/<project-slug>/, memory/discoveries/<project-slug>/, memory/fixes/<project-slug>/, memory/references/<project-slug>/, memory/sessions/<project-slug>/ -> project-scoped durable memory
- Avoid legacy project directories for new notes: memory/tasks, memory/kanban, memory/projects`

const BASIC_MEMORY_SKILL_ROUTING = `Basic Memory workflow:
- Prefer loading an appropriate memory skill before direct Basic Memory mutations
- Use memory-notes when creating or improving notes and relations
- Use memory-tasks for structured task tracking
- Use memory-schema when working with note types or schemas
- Use memory-lifecycle when archiving, moving, or changing note status
- Use memory-ingest when converting unstructured source material into linked notes
- Direct basic-memory_* tool calls are fine for small, obvious follow-up edits once the workflow is already clear`

const legacyBasicMemoryDirectoryRules: LegacyBasicMemoryDirectoryRule[] = [
  {
    pattern: /^memory\/tasks(?:\/|$)/,
    legacyLabel: "memory/tasks",
    recommended: "tasks/",
    reason: "Project task tracking should use the canonical top-level task tree.",
  },
  {
    pattern: /^memory\/kanban(?:\/|$)/,
    legacyLabel: "memory/kanban",
    recommended: "tasks/ or plans/",
    reason: "Kanban-style project tracking should live with project tasks or plans instead of memory-internal folders.",
  },
  {
    pattern: /^memory\/projects(?:\/|$)/,
    legacyLabel: "memory/projects",
    recommended: "projects/",
    reason: "Project home and reference notes should use the canonical top-level projects directory.",
  },
]

function now(): number {
  return Date.now()
}

function truncate(text: string, max = 240): string {
  if (!text) return ""
  return text.length <= max ? text : text.slice(0, max) + "…"
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase()
}

function normalizeDirectory(path: string): string {
  return normalizePath(path).replace(/^\/+|\/+$/g, "")
}

function splitNormalizedDirectory(path: string | undefined): string[] {
  const normalized = normalizeDirectory(path ?? "")
  if (!normalized) return []
  return normalized.split("/").filter(Boolean)
}

function setLastUserText(sessionID: string, text: string) {
  const state = getOrCreateState(sessionID)
  state.lastUserText = text.trim() || undefined
  state.queuedPreferenceRecall = undefined
  state.updatedAt = now()
}

function queuePreferenceRecall(sessionID: string, recall: QueuedPreferenceRecall) {
  const state = getOrCreateState(sessionID)
  state.queuedPreferenceRecall = recall
  state.updatedAt = now()
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function expandHomePath(value: string): string {
  if (!value.startsWith("~")) return value

  const home = process.env.HOME
  if (!home) return value
  if (value === "~") return home
  if (value.startsWith("~/")) return path.join(home, value.slice(2))

  return value
}

function slugifyProjectName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function simplifyToken(value: string): string {
  let token = value.toLowerCase().replace(/[^a-z0-9]+/g, "")
  if (!token) return ""

  if (token.endsWith("ies") && token.length > 4) return token.slice(0, -3) + "y"
  if (token.endsWith("ing") && token.length > 5) token = token.slice(0, -3)
  else if (token.endsWith("ed") && token.length > 4) token = token.slice(0, -2)
  else if (token.endsWith("es") && token.length > 4) token = token.slice(0, -2)
  else if (token.endsWith("s") && token.length > 3) token = token.slice(0, -1)

  return token
}

function tokenize(text: string): string[] {
  const stopWords = new Set([
    "a",
    "an",
    "and",
    "are",
    "for",
    "from",
    "into",
    "its",
    "not",
    "please",
    "should",
    "that",
    "the",
    "them",
    "thi",
    "this",
    "use",
    "with",
    "wire",
    "your",
  ])

  const tokens = new Set<string>()
  for (const raw of text.split(/[^A-Za-z0-9]+/)) {
    const token = simplifyToken(raw)
    if (!token || token.length < 3 || stopWords.has(token)) continue
    tokens.add(token)
  }

  return [...tokens]
}

function normalizePreferenceText(text: string): string {
  return normalizeWhitespace(text).toLowerCase()
}

function headingPreferenceScore(headingPath: string[]): number {
  const headingText = headingPath.join(" / ").toLowerCase()
  if (!headingText) return 0

  let score = 0

  if (/\bpreferences?\b/.test(headingText)) score += 6
  if (/\bconstraints?\b/.test(headingText)) score += 6
  if (/\bconventions?\b/.test(headingText)) score += 5
  if (/\b(workflow|engineering|coding|testing|frontend|backend|tooling|quality|style)\b/.test(headingText)) {
    score += 2
  }

  return score
}

function textPreferenceScore(text: string): number {
  let score = 0

  if (/\b(prefer|preferred|must|never|always|avoid|default|consult)\b/i.test(text)) score += 4
  if (/\b(use|using)\b/i.test(text) && /\b(format|convention|typescript|javascript|react|query|test|mock|docs?)\b/i.test(text)) {
    score += 2
  }

  return score
}

function createPreferenceCandidateId(source: string, scope: PreferenceScope, headingPath: string[], text: string): string {
  return [scope, source, ...headingPath, normalizePreferenceText(text)]
    .join("|")
    .replace(/\s+/g, "-")
}

export function extractPreferenceCandidates(
  markdown: string,
  options: ExtractPreferenceCandidateOptions
): PreferenceCandidate[] {
  const lines = markdown.split(/\r?\n/)
  const headingPath: string[] = []
  const results: PreferenceCandidate[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const headingMatch = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (headingMatch) {
      const level = headingMatch[1].length
      headingPath[level - 1] = normalizeWhitespace(headingMatch[2])
      headingPath.length = level
      continue
    }

    const bulletMatch = /^\s*[-*+]\s+(.+?)\s*$/.exec(line)
    if (!bulletMatch) continue

    const segments = [bulletMatch[1].trim()]
    let cursor = index + 1
    while (cursor < lines.length) {
      const continuation = lines[cursor]
      if (!continuation.trim()) break
      if (/^(#{1,6})\s+/.test(continuation)) break
      if (/^\s*[-*+]\s+/.test(continuation)) break
      if (!/^\s+/.test(continuation)) break

      segments.push(continuation.trim())
      cursor += 1
    }

    index = cursor - 1

    const text = normalizeWhitespace(segments.join(" "))
    const baselineScore = headingPreferenceScore(headingPath) + textPreferenceScore(text)
    if (baselineScore < 6) continue

    results.push({
      id: createPreferenceCandidateId(options.source, options.scope, headingPath, text),
      source: options.source,
      scope: options.scope,
      text,
      headingPath: [...headingPath],
      tokens: tokenize(`${headingPath.join(" ")} ${text}`),
      baselineScore,
    })
  }

  return results
}

function compareCandidatePriority(left: PreferenceCandidate, right: PreferenceCandidate): number {
  if (left.headingPath.length !== right.headingPath.length) return left.headingPath.length - right.headingPath.length
  return left.text.localeCompare(right.text)
}

function compareBaselinePriority(left: PreferenceCandidate, right: PreferenceCandidate): number {
  if (left.baselineScore !== right.baselineScore) return right.baselineScore - left.baselineScore
  if (left.scope !== right.scope) return left.scope === "project" ? -1 : 1
  return compareCandidatePriority(left, right)
}

function appendScopedPreferenceItems(
  lines: string[],
  candidates: PreferenceCandidate[],
  projectSlug?: string
) {
  const globalCandidates = candidates.filter((candidate) => candidate.scope === "global")
  const projectCandidates = candidates.filter((candidate) => candidate.scope === "project")

  if (globalCandidates.length) {
    lines.push("Global preferences:")
    for (const item of globalCandidates) {
      lines.push(`- ${item.text}`)
    }
  }

  if (projectCandidates.length) {
    lines.push(projectSlug ? `Project preferences for ${projectSlug}:` : "Project preferences:")
    for (const item of projectCandidates) {
      lines.push(`- ${item.text}`)
    }
  }
}

function dedupePreferenceCandidates(candidates: PreferenceCandidate[]): PreferenceCandidate[] {
  const deduped = new Map<string, PreferenceCandidate>()

  for (const candidate of candidates) {
    const key = normalizePreferenceText(candidate.text)
    const existing = deduped.get(key)
    if (
      !existing ||
      candidate.scope === "project" && existing.scope !== "project" ||
      candidate.scope === existing.scope && candidate.baselineScore > existing.baselineScore ||
      candidate.scope === existing.scope && candidate.baselineScore === existing.baselineScore && compareCandidatePriority(candidate, existing) < 0
    ) {
      deduped.set(key, candidate)
    }
  }

  return [...deduped.values()]
}

function scoreRelevantCandidate(candidate: PreferenceCandidate, queryTokens: string[]): number {
  if (!queryTokens.length) return 0

  const candidateTokens = new Set(candidate.tokens.map((token) => simplifyToken(token)).filter(Boolean))

  let overlap = 0
  for (const token of queryTokens) {
    if (candidateTokens.has(token)) overlap += 1
  }

  if (!overlap) return 0

  return overlap * 10 + candidate.baselineScore + (candidate.scope === "project" ? 4 : 0)
}

export function selectPreferenceRecall(
  candidates: PreferenceCandidate[],
  userText: string,
  options?: {
    baselineLimit?: number
    relevantLimit?: number
  }
): PreferenceRecall {
  const uniqueCandidates = dedupePreferenceCandidates(candidates)
  const baselineLimit = options?.baselineLimit ?? PREFERENCE_BASELINE_LIMIT
  const relevantLimit = options?.relevantLimit ?? PREFERENCE_RELEVANT_LIMIT
  const queryTokens = tokenize(userText)

  const baseline = [...uniqueCandidates]
    .sort((left, right) => compareBaselinePriority(left, right))
    .slice(0, baselineLimit)

  const relevant = [...uniqueCandidates]
    .map((candidate) => ({
      candidate,
      score: scoreRelevantCandidate(candidate, queryTokens),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score
      return compareBaselinePriority(left.candidate, right.candidate)
    })
    .slice(0, relevantLimit)
    .map((entry) => entry.candidate)

  return { baseline, relevant }
}

function formatPreferenceRecall(recall: PreferenceRecall, projectSlug?: string): string | undefined {
  if (!recall.baseline.length && !recall.relevant.length) return undefined

  const lines = ["Preference recall:"]

  if (recall.baseline.length) {
    lines.push("Baseline preferences:")
    appendScopedPreferenceItems(lines, recall.baseline, projectSlug)
  }

  if (recall.relevant.length) {
    lines.push(projectSlug ? `Request-relevant preferences for ${projectSlug}:` : "Request-relevant preferences:")
    appendScopedPreferenceItems(lines, recall.relevant, projectSlug)
  }

  return lines.join("\n")
}

function formatPreferenceRecallDebug(resolution: ResolvedPreferenceRecall): string {
  const lines = ["Preference recall debug", `Query: ${resolution.queryText}`]

  if (resolution.sources.length) {
    lines.push("Sources:")
    for (const source of resolution.sources) {
      lines.push(`- ${source}`)
    }
  }

  lines.push(resolution.formattedText)

  return lines.join("\n")
}

function formatQueuedPreferenceRecall(recall: QueuedPreferenceRecall): string {
  return ["Queued preference recall", `Query: ${recall.queryText}`, recall.formattedText].join("\n")
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

function relativePreferenceSource(rootPath: string, notePath: string): string {
  const relative = path.relative(rootPath, notePath)
  return relative && !relative.startsWith("..") ? relative.replace(/\\/g, "/") : notePath
}

async function loadPreferenceCandidatesFromNote(
  rootPath: string,
  notePath: string,
  scope: PreferenceScope
): Promise<PreferenceCandidate[]> {
  const source = relativePreferenceSource(rootPath, notePath)

  try {
    const stat = await fs.stat(notePath)
    const cached = noteCache.get(notePath)
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.candidates

    const markdown = await fs.readFile(notePath, "utf8")
    const candidates = extractPreferenceCandidates(markdown, { scope, source })
    noteCache.set(notePath, { mtimeMs: stat.mtimeMs, candidates })
    return candidates
  } catch {
    return []
  }
}

async function getDefaultBasicMemoryProjectPath($: any): Promise<string | undefined> {
  if (!basicMemoryProjectPathPromise) {
    basicMemoryProjectPathPromise = (async () => {
      try {
        const result = await $`uvx basic-memory project list --json`.quiet().nothrow()
        const stdout = String(result.stdout ?? "").trim()
        if (!stdout) return undefined

        const payload = JSON.parse(stdout) as {
          projects?: Array<{ local_path?: string; is_default?: boolean }>
        }
        const project =
          payload.projects?.find((item) => item.is_default && item.local_path) ??
          payload.projects?.find((item) => item.local_path)

        return project?.local_path ? expandHomePath(project.local_path) : undefined
      } catch {
        return undefined
      }
    })()
  }

  return basicMemoryProjectPathPromise
}

function getProjectSlugCandidates(worktree: string, directory: string): string[] {
  const candidates = new Set<string>()
  const values = [path.basename(worktree || ""), path.basename(directory || "")]

  for (const value of values) {
    if (!value || value === path.sep || value === ".") continue
    candidates.add(value.toLowerCase())

    const slug = slugifyProjectName(value)
    if (slug) candidates.add(slug)
  }

  return [...candidates].filter((value) => value && value !== "home")
}

async function resolveProjectPreferenceNote(
  rootPath: string,
  worktree: string,
  directory: string
): Promise<{ slug?: string; notePath?: string }> {
  for (const slug of getProjectSlugCandidates(worktree, directory)) {
    const notePath = path.join(rootPath, "memory", "config", `${slug}.md`)
    if (await fileExists(notePath)) {
      return { slug, notePath }
    }
  }

  return {}
}

async function resolvePreferenceRecall(
  $: any,
  worktree: string,
  directory: string,
  userText: string | undefined
): Promise<ResolvedPreferenceRecall | undefined> {
  const queryText = normalizeWhitespace(userText ?? "")
  if (!queryText) return undefined

  const rootPath = await getDefaultBasicMemoryProjectPath($)
  if (!rootPath) return undefined

  const candidates: PreferenceCandidate[] = []
  const sources: string[] = []
  const globalPath = path.join(rootPath, "memory", "config", "global.md")
  if (await fileExists(globalPath)) {
    candidates.push(...(await loadPreferenceCandidatesFromNote(rootPath, globalPath, "global")))
    sources.push(relativePreferenceSource(rootPath, globalPath))
  }

  const projectPreference = await resolveProjectPreferenceNote(rootPath, worktree, directory)
  if (projectPreference.notePath) {
    candidates.push(...(await loadPreferenceCandidatesFromNote(rootPath, projectPreference.notePath, "project")))
    sources.push(relativePreferenceSource(rootPath, projectPreference.notePath))
  }

  if (!candidates.length) return undefined

  const recall = selectPreferenceRecall(candidates, queryText)
  const formattedText = formatPreferenceRecall(recall, projectPreference.slug)
  if (!formattedText) return undefined

  return {
    queryText,
    projectSlug: projectPreference.slug,
    sources,
    recall,
    formattedText,
  }
}

async function buildPreferenceRecallText(
  $: any,
  worktree: string,
  directory: string,
  userText: string | undefined
): Promise<string | undefined> {
  const resolution = await resolvePreferenceRecall($, worktree, directory, userText)
  return resolution?.formattedText
}

async function getCurrentPreferenceRecallText(
  $: any,
  sessionID: string,
  worktree: string,
  directory: string
): Promise<string> {
  const state = getOrCreateState(sessionID)
  if (state.queuedPreferenceRecall) {
    return formatQueuedPreferenceRecall(state.queuedPreferenceRecall)
  }

  const automatic = await resolvePreferenceRecall($, worktree, directory, state.lastUserText)
  if (!automatic) {
    return "No preference recall is currently queued or auto-resolved for this session."
  }

  return ["Currently auto-injected preference recall", formatPreferenceRecallDebug(automatic)].join("\n")
}

export function resetBasicMemoryPluginTestState() {
  sessionStates.clear()
  noteCache.clear()
  basicMemoryProjectPathPromise = undefined
}

function getOrCreateState(sessionID: string): SessionState {
  let state = sessionStates.get(sessionID)
  if (!state) {
    state = {
      sessionID,
      createdAt: now(),
      updatedAt: now(),
      storageMode: DEFAULT_STORAGE_MODE,
      idleCount: 0,
      hadError: false,
      sawDiff: false,
      events: [],
      pendingMemoryCandidates: [],
    }
    sessionStates.set(sessionID, state)
  }
  return state
}

function clearState(sessionID: string) {
  sessionStates.delete(sessionID)
}

function setStorageMode(sessionID: string, mode: SessionStorageMode, reason: string) {
  const state = getOrCreateState(sessionID)
  if (state.storageMode === mode) return

  state.storageMode = mode
  state.updatedAt = now()
  addEvent(sessionID, {
    type: "policy-change",
    label: `Session storage mode: ${mode}`,
    detail: reason,
    timestamp: now(),
  })
}

function addEvent(sessionID: string, event: SessionEvent) {
  const state = getOrCreateState(sessionID)
  state.updatedAt = now()
  state.events.push(event)

  // Keep state bounded.
  if (state.events.length > 40) {
    state.events.splice(0, state.events.length - 40)
  }
}

function addCandidate(sessionID: string, candidate: string) {
  const state = getOrCreateState(sessionID)
  if (!state.pendingMemoryCandidates.includes(candidate)) {
    state.pendingMemoryCandidates.push(candidate)
  }

  if (state.pendingMemoryCandidates.length > 20) {
    state.pendingMemoryCandidates.splice(0, state.pendingMemoryCandidates.length - 20)
  }

  state.updatedAt = now()
}

function getStringArg(args: unknown, keys: string[]): string | undefined {
  if (!args || typeof args !== "object") return undefined
  const record = args as Record<string, unknown>

  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return value
  }

  return undefined
}

function getTextParts(parts: Array<{ type?: string; text?: string }>): string {
  return parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n")
}

function getPatchPathsFromArgs(args: unknown): string[] {
  const patchText = getStringArg(args, ["patchText", "patch", "diff"])
  if (!patchText) return []

  return Array.from(patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm), (match) =>
    match[1].trim()
  )
}

function getPathFromArgs(args: unknown): string | undefined {
  return (
    getStringArg(args, ["path", "filePath", "filename", "file", "target"]) ??
    getPatchPathsFromArgs(args)[0]
  )
}

function getContentFromArgs(args: unknown): string {
  return (
    getStringArg(args, ["content", "contents", "text", "body", "value", "diff", "patch"]) ?? ""
  )
}

function getTitleFromArgs(args: unknown): string {
  return getStringArg(args, ["title", "name"]) ?? "Untitled"
}

function getDirectoryFromArgs(args: unknown): string {
  return getStringArg(args, ["directory", "dir", "folder", "destination_folder"]) ?? ""
}

function getParentDirectory(path: string | undefined): string {
  const normalized = normalizeDirectory(path ?? "")
  if (!normalized) return ""

  const slashIndex = normalized.lastIndexOf("/")
  if (slashIndex === -1) return ""

  return normalized.slice(0, slashIndex)
}

function getTargetBasicMemoryDirectory(args: unknown): string {
  const directDirectory = getDirectoryFromArgs(args)
  if (directDirectory) return directDirectory

  return getParentDirectory(getStringArg(args, ["destination_path"]))
}

function getLegacyBasicMemoryDirectoryRule(
  directory: string | undefined
): LegacyBasicMemoryDirectoryRule | undefined {
  const normalized = normalizeDirectory(directory ?? "")
  if (!normalized) return undefined

  return legacyBasicMemoryDirectoryRules.find((rule) => rule.pattern.test(normalized))
}

function getProjectScopedDirectoryViolation(
  directory: string | undefined
): ProjectScopedDirectoryViolation | undefined {
  const normalized = normalizeDirectory(directory ?? "")
  const segments = splitNormalizedDirectory(normalized)
  if (!segments.length) return undefined

  const [root, second] = segments

  switch (root) {
    case "projects":
      if (segments.length === 1) {
        return {
          directory: normalized,
          recommended: "projects/<project-slug>/",
          reason: "Project home and reference notes should be scoped under a project slug.",
        }
      }
      return undefined

    case "specs":
      if (segments.length === 1) {
        return {
          directory: normalized,
          recommended: "specs/<project-slug>/",
          reason: "Canonical specs should be grouped by project slug.",
        }
      }
      return undefined

    case "research":
      if (segments.length === 1) {
        return {
          directory: normalized,
          recommended: "research/<project-slug>/",
          reason: "Research syntheses should be grouped by project slug.",
        }
      }

      if (["archive", "imported", "legacy"].includes(second ?? "")) {
        return undefined
      }

      return undefined

    case "plans":
      if (segments.length === 1) {
        return {
          directory: normalized,
          recommended: "plans/<project-slug>/",
          reason: "Plans and roadmaps should be grouped by project slug.",
        }
      }
      return undefined

    case "tasks":
      if (segments.length === 1 || second === "archive") {
        return {
          directory: normalized,
          recommended: "tasks/<project-slug>/ or tasks/<project-slug>/archive/",
          reason: "Project task tracking should be grouped by project slug, with archive nested under that slug.",
        }
      }
      return undefined

    default:
      return undefined
  }
}

function isWriteLikeTool(tool: string): boolean {
  return tool === "write" || tool === "edit" || tool === "apply_patch"
}

function isBasicMemoryTool(tool: string): boolean {
  return tool.startsWith("basic-memory_")
}

function isBasicMemoryWriteTool(tool: string): boolean {
  return tool === "basic-memory_write_note" || tool === "basic-memory_edit_note"
}

function isBasicMemoryMutationTool(tool: string): boolean {
  return (
    tool === "basic-memory_write_note" ||
    tool === "basic-memory_edit_note" ||
    tool === "basic-memory_move_note"
  )
}

function outputLooksLikeError(title: string, output: string): boolean {
  const text = `${title}\n${output}`

  return [
    /\berror\b/i,
    /\bfail(ed|ure)?\b/i,
    /\bexception\b/i,
    /\btraceback\b/i,
    /\bfatal\b/i,
    /\bpanic\b/i,
    /\bexit code [1-9]\d*\b/i,
  ].some((re) => re.test(text))
}

function pathLooksMemoryLike(path: string): boolean {
  const p = normalizePath(path)

  return [
    /(^|\/)memory(\/|$)/,
    /(^|\/)discoveries(\/|$)/,
    /(^|\/)preferences(\/|$)/,
    /(^|\/)patterns(\/|$)/,
    /(^|\/)decisions(\/|$)/,
    /(^|\/)bugfixes(\/|$)/,
    /(^|\/)retrospectives?(\/|$)/,
    /(^|\/)lessons?-learned(\/|$)/,
    /(^|\/)session[-_ ]?summaries?(\/|$)/,
    /(^|\/)session[-_ ]?notes?(\/|$)/,
  ].some((re) => re.test(p))
}

function pathLooksWorkspaceDocLike(path: string): boolean {
  const p = normalizePath(path)

  return [
    /(^|\/)(docs?|specs?|adrs?|rfcs?)(\/|$)/,
    /(^|\/)(readme|architecture|design|spec|specification|rfc|adr)(\.md)?$/,
    /(^|\/)adr[-_ ]?\d+.*\.md$/,
    /(^|\/)rfc[-_ ]?\d+.*\.md$/,
  ].some((re) => re.test(p))
}

function pathLooksResearchLike(path: string): boolean {
  const p = normalizePath(path)

  return [
    /(^|\/)(research|findings|investigations?|evaluations?)(\/|$)/,
    /(^|\/)(research|findings|investigation|evaluation|notes?)(\.md|\.txt)$/,
  ].some((re) => re.test(p))
}

function isMarkdownLikePath(path: string | undefined): boolean {
  return !!path && /\.(md|mdx|txt)$/i.test(path)
}

function pathLooksKnowledgeArtifact(path: string | undefined): boolean {
  return !!path && (isMarkdownLikePath(path) || pathLooksMemoryLike(path) || pathLooksResearchLike(path) || pathLooksWorkspaceDocLike(path))
}

function detectStorageMode(text: string): SessionStorageMode | undefined {
  if (!text) return undefined

  if (/\b(memory-and-artifact|memory and artifact)\b/i.test(text)) {
    return "memory-and-artifact"
  }

  if (/\b(artifact-only|artifact only)\b/i.test(text)) {
    return "artifact-only"
  }

  if (/\b(memory-only|memory only)\b/i.test(text)) {
    return "memory-only"
  }

  return undefined
}

function describeStorageMode(mode: SessionStorageMode): string {
  switch (mode) {
    case "memory-only":
      return "Save docs/notes/knowledge to Basic Memory by default. Only write local implementation artifacts."
    case "artifact-only":
      return "Materialize docs and deliverables in the workspace only. Do not save them to Basic Memory unless the user changes mode."
    case "memory-and-artifact":
      return "Allow both Basic Memory and workspace artifacts when useful, but do not duplicate content unless the user wants both forms."
  }
}

function contentLooksMemoryLike(content: string): boolean {
  const text = content.toLowerCase()
  if (!text) return false

  let score = 0

  const weightedPatterns: Array<[RegExp, number]> = [
    [/\bwhat:\b/i, 2],
    [/\bwhy:\b/i, 2],
    [/\bwhere:\b/i, 2],
    [/\blearned:\b/i, 2],
    [/\bobservation:\b/i, 2],
    [/\buser preference\b/i, 3],
    [/\bconstraint\b/i, 1],
    [/\bcross-session\b/i, 3],
    [/\bworth remembering\b/i, 3],
    [/\bsave to memory\b/i, 3],
    [/\bbasic memory\b/i, 3],
    [/\bbugfix summary\b/i, 3],
    [/\bsession summary\b/i, 2],
    [/\bretrospective\b/i, 2],
  ]

  for (const [re, weight] of weightedPatterns) {
    if (re.test(text)) score += weight
  }

  return score >= 4
}

function contentLooksResearchLike(content: string): boolean {
  const text = content.toLowerCase()
  if (!text) return false

  let score = 0

  const weightedPatterns: Array<[RegExp, number]> = [
    [/\bresearch\b/i, 2],
    [/\bfindings?\b/i, 2],
    [/\bsources?\b/i, 2],
    [/\breferences?\b/i, 2],
    [/\bcomparison\b/i, 1],
    [/\balternatives?\b/i, 1],
    [/\btrade[- ]?offs?\b/i, 2],
    [/\bpros?\b/i, 1],
    [/\bcons?\b/i, 1],
    [/\brecommendation\b/i, 1],
    [/\bevaluat(e|ion)\b/i, 1],
    [/\bbenchmark\b/i, 1],
  ]

  for (const [re, weight] of weightedPatterns) {
    if (re.test(text)) score += weight
  }

  return score >= 4
}

function stripFencedCodeBlocks(content: string): string {
  if (!content) return ""
  return content.replace(/```[\s\S]*?```/g, "")
}

function findHumanLinkFormatWarnings(content: string): string[] {
  const prose = stripFencedCodeBlocks(content)
  if (!prose.trim()) return []

  const warnings = new Set<string>()
  const patterns: Array<[RegExp, string]> = [
    [/`memory:\/\/[^`]+`/g, "Backticked memory:// URL in prose; use [[Wiki Links]] in note content."],
    [/`main\/[A-Za-z0-9_./ -]+`/g, "Backticked Basic Memory permalink/path in prose; use [[Wiki Links]] in note content."],
    [/^\s*[-*]\s+`(?:main\/|memory:\/\/)[^`]+`\s*$/gm, "Navigation list uses programmatic identifiers instead of [[Wiki Links]]."],
    [/`\[\[.*\]\]`/gm, "Backticked [[Wiki Link]] in prose; remove backticks to create a proper link."],
  ]

  for (const [pattern, message] of patterns) {
    if (pattern.test(prose)) warnings.add(message)
  }

  return [...warnings]
}

function shouldHardBlockLocalWrite(path: string | undefined): boolean {
  return !!path && pathLooksMemoryLike(path)
}

function getBlockedLocalWritePath(args: unknown): string | undefined {
  const directPath = getStringArg(args, ["path", "filePath", "filename", "file", "target"])
  if (directPath && shouldHardBlockLocalWrite(directPath)) return directPath

  return getPatchPathsFromArgs(args).find((path) => shouldHardBlockLocalWrite(path))
}

function getModeBlockedLocalWritePath(mode: SessionStorageMode, args: unknown): string | undefined {
  if (mode !== "memory-only") return undefined

  const content = getContentFromArgs(args)
  const directPath = getStringArg(args, ["path", "filePath", "filename", "file", "target"])
  const paths = directPath ? [directPath] : getPatchPathsFromArgs(args)

  return paths.find((path) => pathLooksKnowledgeArtifact(path) && shouldFlagAsMemoryCandidate(path, content))
}

function shouldFlagAsMemoryCandidate(path: string | undefined, content: string): boolean {
  if (path && pathLooksMemoryLike(path)) return true
  if (path && pathLooksWorkspaceDocLike(path) && isMarkdownLikePath(path)) return true
  if ((pathLooksResearchLike(path ?? "") || contentLooksResearchLike(content)) && isMarkdownLikePath(path)) {
    return true
  }
  if (contentLooksMemoryLike(content)) return true

  const normalized = path ? normalizePath(path) : ""

  if (
    normalized &&
    /\.(md|txt)$/i.test(normalized) &&
    /\b(gotcha|lesson learned|lessons learned|follow-up|follow up|preference|constraint)\b/i.test(
      content
    )
  ) {
    return true
  }

  return false
}

function appendGuidance(description: string, guidance: string): string {
  return description.includes(guidance) ? description : `${description.trim()}\n\n${guidance}`
}

function summarizeMemoryWrite(args: unknown): { label: string; detail: string } {
  const title = getTitleFromArgs(args)
  const content = getContentFromArgs(args)
  const text = `${title}\n${content}`.toLowerCase()

  if (/\b(preference|constraint)\b/.test(text)) {
    return { label: `Preference saved: ${title}`, detail: truncate(content) }
  }

  if (/\b(decision|architecture|design)\b/.test(text)) {
    return { label: `Decision saved: ${title}`, detail: truncate(content) }
  }

  if (/\b(discovery|gotcha|learned|observation)\b/.test(text)) {
    return { label: `Discovery saved: ${title}`, detail: truncate(content) }
  }

  if (/\b(bugfix|fixed|fix)\b/.test(text)) {
    return { label: `Bugfix memory saved: ${title}`, detail: truncate(content) }
  }

  return { label: `Memory note saved: ${title}`, detail: truncate(content) }
}

function getSessionIDFromEvent(event: any): string | undefined {
  switch (event?.type) {
    case "session.created":
    case "session.deleted":
    case "session.updated":
      return typeof event?.properties?.info?.id === "string"
        ? event.properties.info.id
        : undefined

    case "session.idle":
    case "session.compacted":
    case "session.status":
    case "session.diff":
    case "session.error":
      return typeof event?.properties?.sessionID === "string"
        ? event.properties.sessionID
        : undefined

    default:
      return undefined
  }
}

function isSessionLifecycleEvent(type: string): boolean {
  return type.startsWith("session.")
}

export const BasicMemoryBoundaryPlugin: Plugin = async ({ client, $, directory, worktree }) => {
  return {
    tool: {
      basic_memory_preference_recall_current: tool({
        description: "Show the preference recall currently queued or auto-resolved for this session.",
        args: {},
        async execute(_args, context) {
          return getCurrentPreferenceRecallText($, context.sessionID, context.worktree, context.directory)
        },
      }),

      basic_memory_preference_recall_debug: tool({
        description: "Preview which Basic Memory preferences would be recalled for a query without queuing injection.",
        args: {
          query: tool.schema.string().optional().describe("Optional text to rank preferences against. Defaults to the most recent user message in this session."),
        },
        async execute(args, context) {
          const state = getOrCreateState(context.sessionID)
          const resolution = await resolvePreferenceRecall($, context.worktree, context.directory, args.query ?? state.lastUserText)

          if (!resolution) {
            return "Preference recall debug\nNo preferences were resolved for this query."
          }

          return formatPreferenceRecallDebug(resolution)
        },
      }),

      basic_memory_preference_recall_inject: tool({
        description: "Recall Basic Memory preferences for a query and queue them for system injection in this session.",
        args: {
          query: tool.schema.string().optional().describe("Optional text to rank preferences against. Defaults to the most recent user message in this session."),
        },
        async execute(args, context) {
          const state = getOrCreateState(context.sessionID)
          const resolution = await resolvePreferenceRecall($, context.worktree, context.directory, args.query ?? state.lastUserText)

          if (!resolution) {
            return "No preference recall could be queued for injection."
          }

          queuePreferenceRecall(context.sessionID, {
            queryText: resolution.queryText,
            projectSlug: resolution.projectSlug,
            formattedText: resolution.formattedText,
          })

          return ["Queued preference recall for injection", formatPreferenceRecallDebug(resolution)].join("\n")
        },
      }),
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      for (const message of [...output.messages].reverse()) {
        if (message.info.role !== "user") continue

        const text = getTextParts(message.parts as Array<{ type?: string; text?: string }>)
        if (message.info.sessionID && text) {
          setLastUserText(message.info.sessionID, text)
        }

        const mode = detectStorageMode(text)
        if (!mode) break

        setStorageMode(message.info.sessionID, mode, "Detected explicit session storage mode in recent user message.")
        break
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      const mode = input.sessionID ? getOrCreateState(input.sessionID).storageMode : DEFAULT_STORAGE_MODE
      const state = input.sessionID ? getOrCreateState(input.sessionID) : undefined
      const lastUserText = state?.lastUserText
      const preferenceRecall = await buildPreferenceRecallText($, worktree, directory, lastUserText)

      output.system.push(`Memory routing:
- Cross-session knowledge -> Basic Memory MCP
- Docs, specs, research, architecture/design notes, and durable knowledge -> Basic Memory MCP by default
- Code, tests, configs, scripts, and other implementation files -> local writes
- Do not write memory artifacts as normal workspace files
- Create workspace copies of docs only when the user explicitly wants a repository artifact

Destination defaults:
- Basic Memory: research findings, external comparisons, exploratory notes, specs, architecture/design notes, preferences, constraints, discoveries, gotchas, bugfix summaries, durable task continuity
- Workspace files: code, tests, configs, scripts, build files, and explicit repository deliverables the user asked to materialize in the workspace
- Do not create both a memory note and a workspace document for the same content unless the user explicitly asks for both
- Avoid creating repo-local research/spec/design docs by default; keep them in Basic Memory unless the user explicitly wants a workspace artifact

Link convention:
- Use [[Wiki Links]] for all human-readable references between notes (Relations section, prose, navigation lists) — these create Obsidian backlinks
- Use memory:// URLs only for programmatic tool calls like build_context(url="memory://...") or read_note(identifier="memory://...")
- Never write \`main/specs/something\` or \`memory://...\` in prose or lists — use [[Wiki Link]] instead

${BASIC_MEMORY_SKILL_ROUTING}

${CANONICAL_BASIC_MEMORY_STRUCTURE}

Active session storage mode: ${mode}
- ${describeStorageMode(mode)}
- To change mode for this session, the user can explicitly say one of: memory-only, artifact-only, memory-and-artifact`)

      if (preferenceRecall) {
        output.system.push(preferenceRecall)
      }

      if (state?.queuedPreferenceRecall) {
        output.system.push(`Manually queued preference recall:\n${state.queuedPreferenceRecall.formattedText}`)
      }
    },

    "tool.definition": async (input, output) => {
      if (input.toolID === "write" || input.toolID === "edit" || input.toolID === "apply_patch") {
        output.description = appendGuidance(
          output.description,
          `Routing guidance:\n- Use local file tools for implementation artifacts such as code, tests, configs, scripts, and build files\n- Docs, specs, research notes, architecture/design notes, discoveries, and preferences default to Basic Memory unless the user explicitly asked for a workspace document\n- Respect the active session storage mode: memory-only, artifact-only, or memory-and-artifact\n- Do not mirror the same content to both Basic Memory and local files unless requested`
        )
      }

      if (
        input.toolID === "basic-memory_write_note" ||
        input.toolID === "basic-memory_edit_note" ||
        input.toolID === "basic-memory_move_note"
      ) {
        output.description = appendGuidance(
          output.description,
          `Routing guidance:\n- Use Basic Memory by default for cross-session knowledge and documentation: research findings, specs, architecture/design notes, discoveries, preferences, constraints, retrospectives, and durable task continuity\n- Respect the active session storage mode: memory-only, artifact-only, or memory-and-artifact\n- Only materialize a workspace doc as well when the user explicitly wants a repository artifact such as README, ADR, ARCHITECTURE.md, or another checked-in document\n- Do not create a workspace mirror in addition to the memory note unless the user asked for both forms\n- Use [[Wiki Links]] for all references between notes (Relations section, prose) — never use \`memory://...\` or permalink paths in human-readable content\n- Before direct Basic Memory mutations, prefer the matching skill: memory-notes, memory-tasks, memory-schema, memory-lifecycle, or memory-ingest\n- ${CANONICAL_BASIC_MEMORY_STRUCTURE.replace(/\n/g, "\n- ")}`
        )
      }
    },

    "tool.execute.before": async (input, output) => {
      const sessionID = input.sessionID
      if (!sessionID) return

      const state = getOrCreateState(sessionID)
      const mode = state.storageMode

      if (isBasicMemoryWriteTool(input.tool) && mode === "artifact-only") {
        addEvent(sessionID, {
          type: "blocked-memory-write",
          label: `Blocked by artifact-only: ${getTitleFromArgs(output.args)}`,
          detail: `The active session mode prefers workspace artifacts over Basic Memory notes.`,
          timestamp: now(),
        })

        throw new Error(
          `The active session storage mode is artifact-only, so this Basic Memory write was blocked.` +
            ` Create a workspace artifact instead, or switch the session mode to memory-only or memory-and-artifact.`
        )
      }

      if (isBasicMemoryMutationTool(input.tool)) {
        const targetDirectory = getTargetBasicMemoryDirectory(output.args)
        const content = getContentFromArgs(output.args)
        const legacyDirectoryRule = getLegacyBasicMemoryDirectoryRule(targetDirectory)

        if (legacyDirectoryRule) {
          addEvent(sessionID, {
            type: "blocked-memory-write",
            label: `Blocked legacy Basic Memory directory: ${targetDirectory}`,
            detail:
              `Attempted to write or move a note into legacy directory '${targetDirectory}'. ` +
              `Use '${legacyDirectoryRule.recommended}' instead.`,
            timestamp: now(),
          })

          throw new Error(
            `This Basic Memory write targets legacy directory '${targetDirectory}'. ` +
              `Use '${legacyDirectoryRule.recommended}' instead. ${legacyDirectoryRule.reason}\n\n` +
              `${CANONICAL_BASIC_MEMORY_STRUCTURE}`
          )
        }

        const projectScopedViolation = getProjectScopedDirectoryViolation(targetDirectory)

        if (projectScopedViolation) {
          addEvent(sessionID, {
            type: "blocked-memory-write",
            label: `Blocked unscoped Basic Memory directory: ${projectScopedViolation.directory}`,
            detail:
              `Attempted to write or move a note into '${projectScopedViolation.directory}' without a project slug. ` +
              `Use '${projectScopedViolation.recommended}' instead.`,
            timestamp: now(),
          })

          throw new Error(
            `This Basic Memory write targets '${projectScopedViolation.directory}' without a project slug. ` +
              `Use '${projectScopedViolation.recommended}' instead. ${projectScopedViolation.reason}\n\n` +
              `${CANONICAL_BASIC_MEMORY_STRUCTURE}`
          )
        }

        if (input.tool !== "basic-memory_move_note") {
          const linkWarnings = findHumanLinkFormatWarnings(content)

          if (linkWarnings.length) {
            const title = getTitleFromArgs(output.args)
            addEvent(sessionID, {
              type: "warning",
              label: `Possible bad note links: ${title}`,
              detail: linkWarnings.join(" "),
              timestamp: now(),
            })

            await client.app.log({
              body: {
                service: "basic-memory-boundary",
                level: "warn",
                message: `Possible bad human-readable note links in ${input.tool}`,
                extra: {
                  sessionID,
                  tool: input.tool,
                  title,
                  warnings: linkWarnings,
                },
              },
            })
          }
        }
      }

      if (!isWriteLikeTool(input.tool)) return

      const path = getBlockedLocalWritePath(output.args)

      if (shouldHardBlockLocalWrite(path)) {
        addEvent(sessionID, {
          type: "blocked-local-memory-write",
          label: `Blocked local memory write: ${path ?? "unknown path"}`,
          detail: `Attempted to write to a memory-specific local path: ${path ?? "unknown"}`,
          timestamp: now(),
        })

        throw new Error(
          `This write targets a memory-specific path and was blocked. ` +
            `Store memory artifacts via Basic Memory MCP instead of writing them as normal workspace files.` +
            (path ? `\n\nBlocked path: ${path}` : "")
        )
      }

      const modeBlockedPath = getModeBlockedLocalWritePath(mode, output.args)
      if (modeBlockedPath) {
        addEvent(sessionID, {
          type: "blocked-local-memory-write",
          label: `Blocked by ${mode}: ${modeBlockedPath}`,
          detail: `This looks like a knowledge artifact that should stay in Basic Memory under the active session mode.`,
          timestamp: now(),
        })

        throw new Error(
          `The active session storage mode is ${mode}, so this local write was blocked.` +
            ` Save this doc/note/spec to Basic Memory instead, or switch the session mode to artifact-only or memory-and-artifact.` +
            `\n\nBlocked path: ${modeBlockedPath}`
        )
      }
    },

    "tool.execute.after": async (input, output) => {
      const sessionID = input.sessionID
      if (!sessionID) return

      const state = getOrCreateState(sessionID)
      state.updatedAt = now()

      const title = output?.title || ""
      const out = output?.output || ""

      if (outputLooksLikeError(title, out)) {
        addEvent(sessionID, {
          type: "error",
          label: `${input.tool} failed`,
          detail: truncate(out || title),
          timestamp: now(),
        })
        state.hadError = true
        return
      }

      if (isBasicMemoryWriteTool(input.tool)) {
        const summary = summarizeMemoryWrite(input.args)
        addEvent(sessionID, {
          type: "memory-write",
          label: summary.label,
          detail: summary.detail,
          timestamp: now(),
        })

        return
      }

      if (isBasicMemoryTool(input.tool)) {
        return
      }

      if (!isWriteLikeTool(input.tool)) return

      const path = getPathFromArgs(input.args)
      const content = getContentFromArgs(input.args)

      if (shouldFlagAsMemoryCandidate(path, content)) {
        const label = `Local artifact may deserve memory: ${path ?? "unknown path"}`
        addEvent(sessionID, {
          type: "memory-worthy",
          label,
          detail:
            `A local write may contain durable knowledge worth saving separately to Basic Memory.\n` +
            `Path: ${path ?? "unknown"}\n` +
            `Preview: ${truncate(content, 120)}`,
          timestamp: now(),
        })
        addCandidate(sessionID, label)
      }
    },

    "experimental.session.compacting": async (input, output) => {
      const sessionID = input.sessionID
      if (!sessionID) return

      const state = sessionStates.get(sessionID)
      if (!state) return

      const blocked = state.events.filter((e) => e.type === "blocked-local-memory-write")
      const blockedMemoryWrites = state.events.filter((e) => e.type === "blocked-memory-write")
      const memoryWrites = state.events.filter((e) => e.type === "memory-write")
      const policyChanges = state.events.filter((e) => e.type === "policy-change")
      const candidates = state.events.filter((e) => e.type === "memory-worthy")
      const warnings = state.events.filter((e) => e.type === "warning")
      const errors = state.events.filter((e) => e.type === "error")

      const sections: string[] = []

      if (memoryWrites.length) {
        sections.push(
          `### Already saved to Basic Memory\n${memoryWrites
            .slice(-5)
            .map((e) => `- ${e.label}`)
            .join("\n")}`
        )
      }

      if (blocked.length) {
        sections.push(
          `### Blocked local writes\n${blocked
            .slice(-5)
            .map((e) => `- ${e.label}`)
            .join("\n")}`
        )
      }

      if (blockedMemoryWrites.length) {
        sections.push(
          `### Blocked Basic Memory writes\n${blockedMemoryWrites
            .slice(-5)
            .map((e) => `- ${e.label}`)
            .join("\n")}`
        )
      }

      if (policyChanges.length) {
        sections.push(
          `### Session storage mode changes\n${policyChanges
            .slice(-5)
            .map((e) => `- ${e.label}`)
            .join("\n")}`
        )
      }

      if (candidates.length) {
        sections.push(
          `### Local artifacts that may need separate memory notes\n${candidates
            .slice(-5)
            .map((e) => `- ${e.label}`)
            .join("\n")}`
        )
      }

      if (warnings.length) {
        sections.push(
          `### Warnings\n${warnings
            .slice(-5)
            .map((e) => `- ${e.label}`)
            .join("\n")}`
        )
      }

      if (errors.length) {
        sections.push(
          `### Recent errors\n${errors
            .slice(-3)
            .map((e) => `- ${e.label}`)
            .join("\n")}`
        )
      }

      if (!sections.length) return

      output.context.unshift(`Memory compaction guidance

        Active session storage mode: ${state.storageMode}
        - ${describeStorageMode(state.storageMode)}

        Only save information to Basic Memory if it is useful for future recall across sessions.

        Save to Basic Memory:
        - decisions
        - discoveries and gotchas
        - research findings and exploratory notes
        - specs and architecture/design documentation
        - preferences
        - patterns
        - bugfix summaries worth remembering
        - durable plan/task continuity

        Do not save to Basic Memory:
        - code edits
        - tests and config changes
        - generated artifacts

        Prefer Basic Memory over repo-local docs, specs, and research notes unless the user explicitly asked for a workspace document.

        ${sections.join("\n\n")}`)
    },

    event: async ({ event }) => {
      const sessionID = getSessionIDFromEvent(event)

      if (!sessionID) {
        if (isSessionLifecycleEvent(event.type)) {
          await client.app.log({
            body: {
              service: "basic-memory-boundary",
              level: "warn",
              message: `Could not extract session ID from ${event.type}`,
            },
          })
        }
        return
      }

      if (event.type === "session.created") {
        getOrCreateState(sessionID)
      }

      if (event.type === "session.updated") {
        const state = getOrCreateState(sessionID)
        state.updatedAt = now()
      }

      if (event.type === "session.status") {
        const state = getOrCreateState(sessionID)
        state.updatedAt = now()
        const maybeStatus =
          typeof event?.properties?.status === "string" ? event.properties.status : undefined
        state.lastStatus = maybeStatus
      }

      if (event.type === "session.diff") {
        const state = getOrCreateState(sessionID)
        state.updatedAt = now()
        state.sawDiff = true
      }

      if (event.type === "session.error") {
        const state = getOrCreateState(sessionID)
        state.updatedAt = now()
        state.hadError = true
        addEvent(sessionID, {
          type: "error",
          label: "Session error",
          detail: truncate(JSON.stringify(event), 180),
          timestamp: now(),
        })
      }

      if (event.type === "session.idle") {
        const state = getOrCreateState(sessionID)
        state.updatedAt = now()
        state.idleCount += 1

        const hasCandidate = state.events.some((e) => e.type === "memory-worthy")
        const hasMemoryWrite = state.events.some((e) => e.type === "memory-write")

        if (state.sawDiff && !hasMemoryWrite && !hasCandidate) {
          addEvent(sessionID, {
            type: "warning",
            label: "Session changed files but saved no memory",
            detail: "The session produced diffs, but no memory-worthy artifact has been identified.",
            timestamp: now(),
          })
        }
      }

      if (event.type === "session.compacted") {
        const state = getOrCreateState(sessionID)
        state.updatedAt = now()
      }

      if (event.type === "session.deleted") {
        clearState(sessionID)
      }

      if (
        event.type === "session.error" ||
        event.type === "session.idle" ||
        event.type === "session.compacted"
      ) {
        await client.app.log({
          body: {
            service: "basic-memory-boundary",
            level: "debug",
            message: `Session event: ${event.type}`,
            extra: {
              sessionID,
              type: event.type,
            },
          },
        })
      }
    },
  }
}

