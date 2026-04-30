import type { Plugin } from "@opencode-ai/plugin"
import { OCEvolverPlugin, createOCEvolverPlugin, createServerPlugin } from "./src/oc-evolver.ts"

export { OCEvolverPlugin, createOCEvolverPlugin, createServerPlugin }
export const server: Plugin = async (ctx) => createServerPlugin()(ctx)
export * from "./src/oc-evolver.ts"
