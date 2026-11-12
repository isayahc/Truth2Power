import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { Snapshot } from "./snapshots.ts"

export type PDFPage = { page: number; text: string }

export async function extractPDF(snapshot: Pick<Snapshot, "path" | "sha256">, projectDirectory: string): Promise<PDFPage[]> {
  if (createHash("sha256").update(await readFile(snapshot.path)).digest("hex") !== snapshot.sha256) {
    throw new Error("PDF changed since download verification")
  }
  const python = process.env.T2P_PYTHON ?? join(projectDirectory, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python")
  const { stdout } = await promisify(execFile)(python, ["-c", `import sys,json,pymupdf
with pymupdf.open(sys.argv[1]) as doc:
 print(json.dumps([{'page':i+1,'text':p.get_text()} for i,p in enumerate(doc)],ensure_ascii=True))`, snapshot.path],
    { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })
  const pages: PDFPage[] = JSON.parse(stdout)
  if (!pages.length || pages.some(p => !Number.isInteger(p.page) || typeof p.text !== "string" || !p.text.trim())) {
    throw new Error("PDF has unreadable or text-free pages; OCR or visual reading is required")
  }
  if (pages.reduce((n, p) => n + p.text.length, 0) > 100_000) throw new Error("PDF exceeds text context limit")
  return pages
}
