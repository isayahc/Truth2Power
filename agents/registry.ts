import { websiteAndPolicy } from "./website-and-policy/agent.ts"
import { applicationFinancialterms } from "./application-financialterms/agent.ts"
import { languageSummary } from "./language-summary/agent.ts"

export const auditAgents = {
  [websiteAndPolicy.id]: websiteAndPolicy,
  [applicationFinancialterms.id]: applicationFinancialterms,
  [languageSummary.id]: languageSummary,
} as const

export type AuditAgent = keyof typeof auditAgents
