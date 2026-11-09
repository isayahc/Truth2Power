# Bilingual UI: English and Spanish

- Every new or changed user-facing UI must provide both English (`en`) and Spanish (`es`) versions. Include headings, navigation, buttons, form labels, validation/errors, loading/empty states, tooltips, and accessibility labels.
- Use the existing `LocaleProvider` / `useLocale` in `src/locale.jsx` and the translation catalog in `src/spanish.js`. Add or update both languages in the same change; do not rely on English fallback as a completed Spanish translation.
- Preserve the language switch, selected language across navigation/reloads, and language-aware shared links. Set appropriate document and section language attributes for assistive technology.
- Keep hospital names, identifiers, numeric findings, and original evidence quotations intact. Translate UI explanations, not source evidence or the meaning of an assessment.
- Existing English-only audit/review panels are migration work, not a precedent for new English-only UI. When adding or changing their user-facing text, supply both language versions. Clearly label any remaining untranslated content and use its actual language attribute.
- Check both languages on desktop and mobile, including keyboard access and longer Spanish text. Extend the existing browser checks when behavior or layout changes warrant it.
- Use clear, patient-friendly Spanish. Track fluent-reader review separately; never claim human translation approval from implementation or passing tests.
