import type { Hospital } from "./shared/run-posted-document.ts"
import type { Model } from "./shared/agent-runtime.ts"

export const stepIds = ["k1", "k2", "k3", "k4", "k5", "k6", "k7", "k8", "k9", "k10", "k11", "k12", "k13", "k14", "k15", "k16", "k17"] as const
export type StepId = typeof stepIds[number]
export type StepResult = { path: string; value: boolean | null; evidence: unknown[] }
export type StepContext = {
  hospital: Hospital; model: Model; paths: Partial<Record<StepId, string>>; reuseFrom?: string
}
export type Step = {
  key: string; criterion: string; dependencies: StepId[]
  run: (context: StepContext) => Promise<StepResult>
}
const reviewPaths = (paths: StepContext["paths"]) => ["k1", "k2", "k3"].map(id => {
  const path = paths[id as StepId]
  if (!path) throw new Error(`Missing prerequisite ${id}`)
  return path
})

// Lazy imports keep help, argument validation and runner tests free of SDK startup.
export const steps: Record<StepId, Step> = {
  k1: { key: "application-posted", criterion: "posted_materials.application_posted", dependencies: [],
    run: async c => (await import("./website-and-policy/application-posted/run.ts")).checkApplicationPosted(c.hospital, c.model, { reuseFrom: c.reuseFrom }) },
  k2: { key: "summary-posted", criterion: "posted_materials.policy_summary_posted", dependencies: ["k1"],
    run: async c => (await import("./website-and-policy/summary-posted/run.ts")).checkSummaryPosted(c.hospital, c.model, { reuseFrom: c.paths.k1 }) },
  k3: { key: "policy-posted", criterion: "posted_materials.policy_statement_posted", dependencies: ["k1"],
    run: async c => (await import("./website-and-policy/policy-posted/run.ts")).checkPolicyPosted(c.hospital, c.model, { reuseFrom: c.paths.k1 }) },
  k4: { key: "consistency", criterion: "posted_materials.consistent_across_documents", dependencies: ["k1", "k2", "k3"],
    run: async c => (await import("./website-and-policy/consistency/run.ts")).checkMaterialsConsistent(c.hospital, c.model, { reuseFrom: reviewPaths(c.paths) }) },
  k5: { key: "service-area", criterion: "posted_materials.primary_service_area_boundaries_compliant", dependencies: ["k1", "k2", "k3"],
    run: async c => (await import("./website-and-policy/service-area/run.ts")).checkServiceArea(c.hospital, c.model, {
      reuseFrom: reviewPaths(c.paths), reviewDate: new Date().toISOString().slice(0, 10),
    }) },
  k6: { key: "submission-deadline", criterion: "posted_materials.no_submission_time_limit", dependencies: ["k1", "k2", "k3"],
    run: async c => (await import("./website-and-policy/submission-deadline/run.ts")).checkSubmissionDeadline(c.hospital, c.model, { reuseFrom: reviewPaths(c.paths) }) },
  k7: { key: "asset-checks", criterion: "posted_materials.no_evidence_of_asset_checks", dependencies: ["k1", "k2", "k3"],
    run: async context => {
      const { checkAssetChecks } = await import("./website-and-policy/asset-checks/run.ts")
      const reuseFrom = reviewPaths(context.paths)
      return checkAssetChecks(context.hospital, context.model, { reuseFrom })
    } },
  k8: { key: "immigration-barrier", criterion: "posted_materials.no_immigration_status_barrier", dependencies: ["k1", "k2", "k3"],
    run: async context => {
      const { checkImmigrationBarrier } = await import("./website-and-policy/immigration-barrier/run.ts")
      const reuseFrom = reviewPaths(context.paths)
      return checkImmigrationBarrier(context.hospital, context.model, { reuseFrom })
    } },
  k9: { key: "uniform-application", criterion: "application.uniform_application", dependencies: ["k1"],
    run: async context => {
      const { checkUniformApplication } = await import("./application-financialterms/uniform-application/run.ts")
      return checkUniformApplication(context.hospital, context.model, { reuseFrom: [context.paths.k1!] })
    } },
  k10: { key: "contact-information", criterion: "application.contact_information", dependencies: ["k1"],
    run: async context => {
      const { checkContactInformation } = await import("./application-financialterms/contact-information/run.ts")
      return checkContactInformation(context.hospital, context.model, { reuseFrom: [context.paths.k1!] })
    } },
  k11: { key: "income-discount-tables", criterion: "application.income_discount_tables", dependencies: ["k1"],
    run: async context => {
      const { checkIncomeDiscountTables } = await import("./application-financialterms/income-discount-tables/run.ts")
      return checkIncomeDiscountTables(context.hospital, context.model, { reuseFrom: [context.paths.k1!] })
    } },
  k12: { key: "fpl-guidelines", criterion: "application.fpl_guidelines", dependencies: ["k1"],
    run: async context => {
      const { checkFplGuidelines } = await import("./application-financialterms/fpl-guidelines/run.ts")
      return checkFplGuidelines(context.hospital, context.model, { reuseFrom: [context.paths.k1!] })
    } },
  k13: { key: "maximum-fpl", criterion: "application.maximum_fpl", dependencies: ["k1"],
    run: async context => {
      const { checkMaximumFpl } = await import("./application-financialterms/maximum-fpl/run.ts")
      return checkMaximumFpl(context.hospital, context.model, { reuseFrom: [context.paths.k1!] })
    } },
  k14: { key: "installments-cap", criterion: "application.installments_cap", dependencies: ["k1"],
    run: async context => {
      const { checkInstallmentCap } = await import("./application-financialterms/installments-cap/run.ts")
      return checkInstallmentCap(context.hospital, context.model, { reuseFrom: [context.paths.k1!] })
    } },
  k15: { key: "summary-service-area", criterion: "policy_summary.primary_service_area_described", dependencies: ["k2"],
    run: async context => {
      const { checkSummaryServiceArea } = await import("./language-summary/service-area-described/run.ts")
      return checkSummaryServiceArea(context.hospital, context.model, { reuseFrom: [context.paths.k2!] })
    } },
  k16: { key: "summary-application-process", criterion: "policy_summary.means_of_applying_explained", dependencies: ["k2"],
    run: async context => {
      const { checkSummaryApplicationProcess } = await import("./language-summary/application-process/run.ts")
      return checkSummaryApplicationProcess(context.hospital, context.model, { reuseFrom: [context.paths.k2!] })
    } },
  k17: { key: "summary-income-levels", criterion: "policy_summary.income_levels_included", dependencies: ["k2"],
    run: async context => {
      const { checkSummaryIncomeLevels } = await import("./language-summary/income-levels/run.ts")
      return checkSummaryIncomeLevels(context.hospital, context.model, { reuseFrom: [context.paths.k2!] })
    } },
}
