import { readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { join } from "node:path"
export async function loadFplReference(project: string, year: number) {
  const path = join(project, "references/hhs-poverty-contiguous-v1.json")
  const bytes = await readFile(path)
  const ref = JSON.parse(bytes.toString("utf8"))
  const amounts = ref.years?.[String(year)]?.household_amounts
  if (ref.geography !== "48 contiguous states and District of Columbia" || ref.currency !== "USD" || ref.period !== "annual"
      || !Array.isArray(amounts) || amounts.length !== 8 || amounts.some((a: any) => !Number.isInteger(a) || a <= 0)
      || !String(ref.authority_url).startsWith("https://aspe.hhs.gov/")) throw new Error(`No validated contiguous-US annual USD reference for ${year}`)
  return { path, sha256: createHash("sha256").update(bytes).digest("hex"), year, amounts: amounts as number[],
    sourceUrl: ref.authority_url, locator: ref.source_locator, version: ref.reference_version,
    verifiedOn: ref.verified_on, geography: ref.geography, currency: ref.currency, period: ref.period }
}
export type FplReference = Awaited<ReturnType<typeof loadFplReference>>
