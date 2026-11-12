import { readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { extractPDF } from "../../shared/pdf-text.ts"

// Versioned source and derived render already captured by the project's whole-form
// review. Hashes verify bytes, not template applicability or permission to customize.
export const referenceConfig = {
  version: "NYS-2026-English",
  sourceUrl: "https://www.health.ny.gov/facilities/hospital/financial_assist/hosp_info/docs/2026_uniform_financial_assistance_application.docx",
  sourceHash: "558cb8933ccabf12a6b86acea145f1077cebd4c9e71fc108bacf2d07f333811a",
  renderHash: "4da163d0c2a4775668da0e3c4c682cc787ee218e049a23dc6d6afab0575cee71",
}
export type UniformReference = {
  version: string; sourceUrl: string; sourceHash: string; renderHash: string
  sourcePath: string; renderPath: string; derived: true
  passages: { locator: string; text: string }[]
}
export async function loadUniformReference(project: string): Promise<UniformReference> {
  const sourcePath = join(project, ".audit/live/snapshots", `${referenceConfig.sourceHash}.docx`)
  const renderPath = join(project, ".audit/live/snapshots", `${referenceConfig.renderHash}.pdf`)
  const original = await readFile(sourcePath)
  const render = await readFile(renderPath)
  if (createHash("sha256").update(original).digest("hex") !== referenceConfig.sourceHash
      || createHash("sha256").update(render).digest("hex") !== referenceConfig.renderHash
      || render.subarray(0, 5).toString() !== "%PDF-") throw new Error("Uniform reference or derived render failed integrity verification")
  const pages = await extractPDF({ path: renderPath, sha256: referenceConfig.renderHash }, project)
  if (pages.length !== 6 || pages.some(p => !p.text.trim())) throw new Error("Incomplete reference render")
  return { ...referenceConfig, sourcePath, renderPath, derived: true,
    passages: pages.map(p => ({ locator: `Reference render page ${p.page}`, text: p.text })) }
}
