// Bounded profiles for the existing Python application review and Node synthetic worker.
// Only the cited original text supplies values. Expected amounts in a worker/model draft are ignored.
export function parseProfile(name, quote) {
  const text = quote.replace(/\s+/g, " ").trim();
  if (name === "maximum") {
    const values = [...text.matchAll(/Individuals up to (\d{2,3})% of the federal poverty level are eligible for financial assistance\./ig)];
    return values.length === 1 ? { percent: Number(values[0][1]), hard_ceiling: false } : null;
  }
  if (name === "installments") {
    const values = [...text.matchAll(/Monthly payments cannot exceed (\d+(?:\.\d+)?)% of your gross monthly income/ig)];
    return values.length === 1 ? { percent: Number(values[0][1]), basis: "gross_monthly_income" } : null;
  }
  if (name !== "fpl") return null;
  const worker = /^One-person household\s*\|\s*400% FPL\s*\|\s*\$([\d,]+) per year$/.exec(text);
  if (worker) return { published_year: null, currency: "USD", period: "annual", cells: [
    { household_size: 1, fpl_percent: 400, amount: Number(worker[1].replaceAll(",", "")) }] };
  const header = /Federal Poverty Levels\s*\((20\d{2})\)\s*Household Size\s+200%\s+300%\s+400%/i.exec(text);
  if (!header) return null;
  const table = text.slice(header.index + header[0].length).split("Minimum Discount Rates", 1)[0];
  if (/\b(monthly|weekly|per month|per week)\b/i.test(table)) return null;
  const cells = [];
  for (const row of table.matchAll(/\b(\d{1,2}) Persons?\s+\$([\d,]+)\s+\$([\d,]+)\s+\$([\d,]+)(?=\s|$)/g)) {
    [200, 300, 400].forEach((pct, i) => cells.push({ household_size: Number(row[1]), fpl_percent: pct, amount: Number(row[2+i].replaceAll(",", "")) }));
  }
  return cells.length ? { published_year: Number(header[1]), currency: "USD", period: "annual", cells } : null;
}
