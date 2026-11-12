import { test } from "node:test"
import assert from "node:assert/strict"
import { outsideLanguageScope } from "./language-scope.ts"
test("budget routing excludes labeled other languages and preserves English/Spanish and unknown sources", () => {
  for (const language of ["Polish", "Ukrainian", "Russian", "zh", "Korean"]) assert.equal(outsideLanguageScope(`https://example.org/form-${language}.pdf`), true)
  for (const language of ["English", "Spanish", "en", "es"]) assert.equal(outsideLanguageScope(`https://example.org/form-${language}.pdf`), false)
  assert.equal(outsideLanguageScope("https://example.org/form.pdf", "Polski"), true)
  assert.equal(outsideLanguageScope("https://example.org/form.pdf"), false)
  assert.equal(outsideLanguageScope("https://example.org/english-russian-bilingual.pdf"), false)
})
