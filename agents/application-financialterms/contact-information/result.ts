import type { ReviewSource } from "../../shared/review-sources.ts"
import { contactKey } from "./validate.ts"
import type { ContactReading, ContactDecision } from "./validate.ts"
export const criterion = "application.contact_information"
export type ContactReview = { taskId: string; source: ReviewSource; reading: ContactReading; decisions: ContactDecision[]; confirmationTaskId: string | null }
export function determineContactInformation(reviews: ContactReview[], applicationIds: string[], gaps: string[]) {
  const contacts = reviews.flatMap(r => r.reading.contacts.map((contact, index) => ({ ...contact,
    taskId: r.taskId, sourceUrl: r.source.snapshot.sourceUrl, sha256: r.source.snapshot.sha256,
    retrievedAt: r.source.snapshot.retrievedAt, onApplication: r.source.roles.includes("application"),
    confirmed: r.decisions.find(d => d.index === index)?.confirmed === true,
    confirmationTaskId: r.confirmationTaskId,
  })))
  const applications = applicationIds.map(sha256 => {
    const supported = contacts.filter(c => c.sha256 === sha256 && c.onApplication && c.confirmed)
    return { sha256, value: supported.length ? true : null, contacts: supported }
  })
  // Positive, scoped presence check: a failed web search cannot erase a verified
  // contact printed on a form. No absence finding from a failed or silent reading.
  const value = applications.length && applications.every(a => a.value === true) ? true : null
  const corroboration = contacts.filter(c => c.onApplication && c.confirmed).map(contact => ({
    applicationTaskId: contact.taskId, type: contact.type, value: contact.value,
    websiteTaskIds: contacts.filter(c => !c.onApplication && c.confirmed && contactKey(c) === contactKey(contact)).map(c => c.taskId),
  }))
  return { criterion, value, result: value === true ? "yes" : "unclear",
    reason_code: value === true ? "condition_met" : "insufficient_evidence",
    explanation: value === true ? "Every identified application reviewed has at least one source-matched, separately confirmed application-help contact. Operational reachability was not tested."
      : "At least one identified application lacks a verified application-help contact, or no application was identified; website contacts alone cannot satisfy this criterion.",
    expected: { minimum_application_assistance_channels: 1 }, applications, contacts, corroboration,
    evidence: contacts.filter(c => c.confirmed).map(c => ({ snapshot_id: c.sha256, sha256: c.sha256,
      sourceUrl: c.sourceUrl, retrievedAt: c.retrievedAt, locator: c.locator, quote: c.quote,
      taskId: c.taskId, confirmationTaskId: c.confirmationTaskId, role: c.onApplication ? "application" : "website_corroboration" })),
    limitations: [...gaps, ...reviews.flatMap(r => r.reading.limitations),
      "Presence finding is scoped to identified saved applications; it does not certify every current online form or language variant.",
      "Phone/email/office operation was not tested. Web contact differences are not automatically a contradiction; multiple valid channels may coexist."],
    reviewStatus: "draft-human-review-pending" }
}
