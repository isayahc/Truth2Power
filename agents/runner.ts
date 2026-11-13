import { mkdir, writeFile, rename } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { setTimeout as pause } from "node:timers/promises"
import { join } from "node:path"
import { steps } from "./steps.ts"
import type { StepId, Step, StepContext } from "./steps.ts"
import { findArtifact } from "./artifacts.ts"
import { languageScope } from "./shared/language-scope.ts"
import { auditRoot } from "./shared/audit-root.ts"
import type { Artifact } from "./artifacts.ts"
import type { Hospital } from "./shared/run-posted-document.ts"
import type { Model } from "./shared/agent-runtime.ts"

export const defaultModel = { providerID: "amazon-bedrock", id: "us.amazon.nova-micro-v1:0" }
type Entry = { status: "running" | "succeeded" | "failed" | "reused"; path?: string;
  value?: boolean | null; evidenceCount?: number; retrievedAt?: string[]; error?: string }
type Options = { requested: StepId[]; refresh?: boolean; model?: Model; auditRoot?: string; approvedSteps?: StepId[] }
type Services = { registry?: Record<StepId, Step>; find?: typeof findArtifact; log?: (message: string) => void;
  checkpoint?: (manifest: any) => Promise<void> }

export async function runAudit(hospital: Hospital, options: Options, services: Services = {}) {
  const registry = services.registry ?? steps
  if (!/^[a-z0-9][a-z0-9-]*$/.test(hospital.id)) throw new Error("Invalid hospital ID")
  if (!options.requested.length || options.requested.some(id => !registry[id])) throw new Error("Invalid requested steps")
  const root = options.auditRoot ?? auditRoot()
  const log = services.log ?? console.log
  const find = services.find ?? findArtifact
  const runId = randomUUID()
  const directory = join(root, "hospitals", hospital.id, "runs")
  await mkdir(directory, { recursive: true })
  const path = join(directory, `${runId}.json`)
  const manifest = { runId, hospital, model: options.model ?? defaultModel, requested: options.requested,
    refresh: options.refresh ?? false, languageScope, startedAt: new Date().toISOString(), completedAt: null as string | null,
    status: "running", steps: {} as Partial<Record<StepId, Entry>> }
  const checkpoint = async () => {
    await writeFile(`${path}.tmp`, JSON.stringify(manifest, null, 2))
    for (let attempt = 0; ; attempt++) {
      try { await rename(`${path}.tmp`, path); break }
      catch (error: any) {
        // Windows scanners can briefly lock the previous manifest during replacement.
        if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(error.code) || attempt === 3) throw error
        await pause(50 * (attempt + 1))
      }
    }
    await services.checkpoint?.(manifest)
  }
  const paths: StepContext["paths"] = {}
  const requested = new Set(options.requested)
  const visiting = new Set<StepId>()
  const ensure = async (id: StepId): Promise<void> => {
    if (paths[id]) return
    if (visiting.has(id)) throw new Error(`Cyclic step dependency: ${id}`)
    visiting.add(id)
    const step = registry[id]
    let saved: Artifact | undefined
    if (!options.refresh && (!requested.has(id) || id === "k1")) saved = await find(root, hospital, step)
    if (!requested.has(id) && saved) {
      paths[id] = saved.path
      manifest.steps[id] = { status: "reused", ...saved }
      log(`Reusing ${id}: ${saved.path}\nSource retrieval dates: ${saved.retrievedAt.join(", ")}`)
      await checkpoint()
    } else {
      if (options.approvedSteps && !options.approvedSteps.includes(id)) throw new Error("Preparation changed; approve a new criterion request")
      for (const dependency of step.dependencies) await ensure(dependency)
      manifest.steps[id] = { status: "running" }
      await checkpoint()
      log(`Running ${id}${saved ? ` using sources from ${saved.path} (${saved.retrievedAt.join(", ")})` : ""}`)
      try {
        const result = await step.run({ hospital, model: manifest.model, paths: { ...paths }, reuseFrom: saved?.path })
        paths[id] = result.path
        manifest.steps[id] = { status: "succeeded", path: result.path, value: result.value, evidenceCount: result.evidence.length }
        if (saved) Object.assign(manifest.steps[id]!, { sourceInventory: saved.path, retrievedAt: saved.retrievedAt })
        log(`${id}: ${result.value === null ? "unresolved" : result.value ? "yes" : "no"}; ${result.evidence.length} evidence items; ${result.path}`)
        await checkpoint()
      } catch (error: any) {
        manifest.steps[id] = { status: "failed", error: error.message ?? String(error) }
        await checkpoint()
        throw error
      }
    }
    visiting.delete(id)
  }
  await checkpoint()
  log(`Hospital: ${hospital.name}\nRun manifest: ${path}`)
  try {
    for (const id of options.requested) await ensure(id)
    manifest.status = "succeeded"
  } catch (error) {
    manifest.status = "failed"
    throw error
  } finally {
    manifest.completedAt = new Date().toISOString()
    await checkpoint()
  }
  return { ...manifest, path }
}
