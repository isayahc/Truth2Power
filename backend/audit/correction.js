import { openStore, now } from "./store.js";
// A reviewed note is scoped to this pilot's hospital and measure.
const note = process.argv.slice(2).join(" ").trim();
if (!note || note.length > 2000)
  throw new Error("Provide a reviewer correction of 1–2000 characters.");
const db = openStore();
db.prepare(
  "INSERT INTO corrections(hospital,rule,note,recorded) VALUES(?,?,?,?)",
).run("362", "application.fpl_guidelines", note, now());
db.close();
