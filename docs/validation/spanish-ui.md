# Spanish main page (#45)

## Implemented

Choose **Español** in the header or open `/?lang=es`. The browser remembers the choice when storage is available. An explicit `lang=en` or `lang=es` takes precedence. The switch preserves the selected hospital, filter and search state; shared hospital links retain Spanish. Document language, map button labels, search labels, loading/error messages and the title follow the selection.

Translated scope: main atlas heading/explanation, September 2025 labels, rating legend, filter controls, hospital search, map controls and labels, hospital contact/location summary, assistance links and footer. Hospital names, addresses, original evidence quotations and numeric grades are preserved. The detailed audit/review workflows remain English, labeled as such; English sections have `lang="en"` for assistive technology.

No translation API, extra dependency, server preference or new external request is used. `frontend/src/spanish.js` is the reviewable English-to-Spanish text catalog; `locale.jsx` manages language selection.

## Fluent-reader review — pending

#45 requires approval by a fluent reader. These translations are an assistant-produced draft; implementation and browser tests do not meet that criterion. Keep #45 open until a reader records their name/role, reviewed commit/date, approval or requested corrections, and resolution of those corrections here or in the issue.

Review the catalog and rendered `/?lang=es`, especially **asistencia financiera**, **cumplimiento**, **calificación reprobatoria**, the zero/one-star distinction, and the September 2025 scope statement. Confirm that the language is clear to patients and does not imply a current institutional grade, eligibility determination or medical advice.

## Browser verification

Commands: `npm run build`, `node scripts/test-spanish-e2e.js`, `node scripts/test-hospital-page-e2e.js`.

The Spanish browser check covers switching, URL preference, reload/browser persistence, selected hospital links, keyboard search, empty results, rating filters, document language, accessible controls and horizontal overflow at 1440×1000 and 390×844. English hospital-page regression checks remain intact. Screenshots are local in `.audit/ui/45/{before,after}-{desktop,mobile}.png`; no public upload is implied. Captures use public atlas data without authentication.

The existing fixed-height mobile header caused wrapped language controls to overlap the heading during verification. It now grows to fit its contents; the mobile search field also uses the full toolbar width.

Verification result: production build and all **eight** browser suites passed, including the new Spanish suite. Error/retry translation, blocked browser storage, and keeping the active rating filter while switching languages were also checked. Desktop/mobile screenshots were inspected after the layout fix; no horizontal overflow or header/heading overlap remained.
