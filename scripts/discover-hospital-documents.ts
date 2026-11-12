import { mkdir, writeFile } from "node:fs/promises"
import { loadEnvFile } from "node:process"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { discoverDocuments } from "../agents/document-discovery/index.ts"

const directory = fileURLToPath(new URL("../", import.meta.url))
loadEnvFile(new URL("../.env", import.meta.url))
const website = process.argv[2] ?? "https://erhny.org/patient-guests/financial-assistance-program/"
const { OpenCode } = await import("@opencode/sdk")
await using opencode = await OpenCode.create()
const result = await discoverDocuments(opencode, directory, website)
const outputDirectory = join(directory, ".audit", "discovery")
await mkdir(outputDirectory, { recursive: true })
const path = join(outputDirectory, `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}.json`)
await writeFile(path, JSON.stringify(result, null, 2), { flag: "wx" })
console.log(JSON.stringify({ stage: "document-discovery", count: result.documents.length, sessionID: result.sessionID, path }))
debugger // Inspect result.documents; this run stops after link discovery.
