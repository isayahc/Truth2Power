import type { Hospital } from "./shared/run-posted-document.ts"

export const hospitals: Record<string, Hospital> = {
  ellenville: {
    id: "ellenville-regional-hospital",
    name: "Ellenville Regional Hospital",
    financialAssistanceUrl: "https://erhny.org/patient-guests/financial-assistance-program/",
  },
}

export function resolveHospital(name: string): Hospital {
  const key = name.trim().toLowerCase()
  const hospital = hospitals[key] ?? Object.values(hospitals).find(h =>
    h.id === key || h.name.toLowerCase() === key)
  if (!hospital) throw new Error(`Unknown hospital: ${name}. Registered hospitals: ${Object.keys(hospitals).join(", ")}. Add its verified URL in agents/hospitals.ts.`)
  return hospital
}
