// Budget routing only, never evidence of a document's contents or compliance.
// Unlabelled documents stay eligible rather than being guessed from their names.
export const languageScope = ["en", "es"] as const
export function outsideLanguageScope(url: string, label = "") {
  let path = url
  try { path = decodeURIComponent(new URL(url).pathname) } catch { /* Use supplied label/path. */ }
  const text = `${path} ${label}`.normalize("NFC")
  if (/(?:^|[^a-z])(english|spanish|espa[ñn]ol|ingl[eé]s|en|es)(?:[^a-z]|$)/i.test(text)) return false
  return /(?:^|[^a-z])(polish|polski|ukrainian|russian|chinese|mandarin|cantonese|arabic|french|haitian|creole|korean|bengali|portuguese|italian|vietnamese|urdu|hindi|tagalog|pl|uk|ru|zh|ar|fr|ht|ko|bn|pt|it|vi)(?:[^a-z]|$)/i.test(text)
}
