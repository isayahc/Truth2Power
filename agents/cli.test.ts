import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { parseArgs } from "./cli-options.ts"
import { resolveHospital } from "./hospitals.ts"
import { steps, stepIds } from "./steps.ts"
import type { StepId, Step } from "./steps.ts"
import { runAudit } from "./runner.ts"
import { findArtifact } from "./artifacts.ts"

const hospital = { id: "syn-hospital", name: "Synthetic Hospital", financialAssistanceUrl: "https://example.org/aid" }
const temp = () => mkdtemp(join(process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Temp", "opencode") : tmpdir(), "audit-cli-"))

test("CLI parses selections and rejects invalid input before running agents", () => {
  assert.deepEqual(parseArgs(["ellenville", "--step", "k6"]), { help: false, hospital: "ellenville", requested: ["k6"], refresh: false })
  assert.deepEqual(parseArgs(["ellenville", "--through", "k3", "--refresh"]), { help: false, hospital: "ellenville", requested: ["k1", "k2", "k3"], refresh: true })
  assert.deepEqual(parseArgs(["ellenville"]), { help: false, hospital: "ellenville", requested: [...stepIds], refresh: false })
  assert.deepEqual(parseArgs(["ellenville", "--step", "k7"]), { help: false, hospital: "ellenville", requested: ["k7"], refresh: false })
  assert.deepEqual(parseArgs(["ellenville", "--step", "k8"]), { help: false, hospital: "ellenville", requested: ["k8"], refresh: false })
  assert.deepEqual(parseArgs(["ellenville", "--step", "k9"]), { help: false, hospital: "ellenville", requested: ["k9"], refresh: false })
  assert.deepEqual(parseArgs(["ellenville", "--step", "k10"]), { help: false, hospital: "ellenville", requested: ["k10"], refresh: false })
  assert.deepEqual(parseArgs(["ellenville", "--step", "k11"]), { help: false, hospital: "ellenville", requested: ["k11"], refresh: false })
  assert.deepEqual(parseArgs(["ellenville", "--step", "k12"]), { help: false, hospital: "ellenville", requested: ["k12"], refresh: false })
  assert.deepEqual(parseArgs(["ellenville", "--step", "k13"]), { help: false, hospital: "ellenville", requested: ["k13"], refresh: false })
  assert.deepEqual(parseArgs(["ellenville", "--step", "k14"]), { help: false, hospital: "ellenville", requested: ["k14"], refresh: false })
  assert.deepEqual(parseArgs(["ellenville", "--step", "k15"]), { help: false, hospital: "ellenville", requested: ["k15"], refresh: false })
  assert.deepEqual(parseArgs(["ellenville", "--step", "k16"]), { help: false, hospital: "ellenville", requested: ["k16"], refresh: false })
  assert.deepEqual(parseArgs(["ellenville", "--step", "k17"]), { help: false, hospital: "ellenville", requested: ["k17"], refresh: false })
  for (const args of [[], ["ellenville", "--step", "k18"], ["ellenville", "--step"], ["ellenville", "--step", "k1", "--through", "k2"], ["ellenville", "--typo"]]) assert.throws(() => parseArgs(args))
  assert.equal(parseArgs(["--help"]).help, true)
  assert.equal(resolveHospital("Ellenville Regional Hospital").id, "ellenville-regional-hospital")
  assert.throws(() => resolveHospital("unknown"))
})

function fakeRegistry(calls: StepId[], fail?: StepId): Record<StepId, Step> {
  return Object.fromEntries(stepIds.map(id => [id, { ...steps[id], run: async (context: any) => {
    calls.push(id)
    for (const dep of steps[id].dependencies) assert.ok(context.paths[dep])
    if (id === fail) throw new Error("Synthetic execution failure")
    return { path: `synthetic-${id}.json`, value: null, evidence: [] }
  } }])) as Record<StepId, Step>
}

test("single step reuses prerequisites and reruns the requested criterion", async () => {
  const calls: StepId[] = []
  const result = await runAudit(hospital, { requested: ["k6"], auditRoot: await temp() }, {
    registry: fakeRegistry(calls), log: () => {},
    find: async (_root, _hospital, step) => ({ path: `${step.key}.json`, retrievedAt: ["2026-11-11T00:00:00Z"] }),
  })
  assert.deepEqual(calls, ["k6"])
  assert.equal(result.steps.k1?.status, "reused")
  assert.equal(result.steps.k6?.value, null)
  assert.equal(result.status, "succeeded")
  assert.equal(JSON.parse(await readFile(result.path, "utf8")).status, "succeeded")
})

test("missing prerequisites run once; unresolved findings allow later criteria", async () => {
  const calls: StepId[] = []
  await runAudit(hospital, { requested: ["k6"], auditRoot: await temp() }, {
    registry: fakeRegistry(calls), find: async () => undefined, log: () => {},
  })
  assert.deepEqual(calls, ["k1", "k2", "k3", "k6"])
})

test("refresh skips old inventories and execution failures retain progress for next invocation", async () => {
  const root = await temp()
  const calls: StepId[] = []
  await assert.rejects(runAudit(hospital, { requested: ["k6"], refresh: true, auditRoot: root }, {
    registry: fakeRegistry(calls, "k3"), find: async () => { throw new Error("Refresh must not look up old artifacts") }, log: () => {},
  }), /Synthetic execution failure/)
  assert.deepEqual(calls, ["k1", "k2", "k3"])
  const directory = join(root, "hospitals", hospital.id, "runs")
  const manifest = JSON.parse(await readFile(join(directory, (await readdir(directory))[0]), "utf8"))
  assert.equal(manifest.status, "failed")
  assert.equal(manifest.steps.k1.status, "succeeded")
  assert.equal(manifest.steps.k3.status, "failed")
  assert.ok(manifest.completedAt)
})

test("artifact discovery verifies hospital, criterion and original file bytes", async () => {
  const root = await temp()
  const directory = join(root, "agents", steps.k1.key, "synthetic-run")
  await mkdir(directory, { recursive: true })
  const sourcePath = join(directory, "source.html")
  const bytes = Buffer.from("<p>Synthetic public hospital source</p>")
  await writeFile(sourcePath, bytes)
  const hash = createHash("sha256").update(bytes).digest("hex")
  const graphPath = join(directory, "tasks.json")
  await writeFile(graphPath, JSON.stringify({ hospitalId: hospital.id, tasks: [{ id: "fetch-page", status: "succeeded", result: {
    path: sourcePath, kind: "html", sha256: hash, snapshot_id: hash, bytes: bytes.length, retrievedAt: "2026-11-11T00:00:00Z",
  } }] }))
  const path = join(directory, "result.json")
  const result = { hospital, criterion: steps.k1.criterion, value: null, taskGraph: graphPath }
  await writeFile(path, JSON.stringify(result))
  assert.equal((await findArtifact(root, hospital, steps.k1))?.path, path)
  assert.equal(await findArtifact(root, { ...hospital, id: "syn-other" }, steps.k1), undefined)
  assert.equal(await findArtifact(root, { ...hospital, financialAssistanceUrl: "https://example.org/other" }, steps.k1), undefined)
  await writeFile(path, JSON.stringify({ ...result, criterion: "wrong" }))
  assert.equal(await findArtifact(root, hospital, steps.k1), undefined)
  await writeFile(path, JSON.stringify(result))
  await writeFile(sourcePath, "tampered")
  assert.equal(await findArtifact(root, hospital, steps.k1), undefined)
})
