import { readFile } from "node:fs/promises";
import { directory, openStore, enqueue, history } from "./store.js";

let db;
/** Local-only fixture and audit endpoints shared by development and production. */
export async function auditRoute(req, res, path, port) {
  if (path.startsWith("/audit-demo/")) {
    const name = path.slice("/audit-demo/".length);
    if (!["index.html", "application.pdf"].includes(name)) {
      res.writeHead(404).end();
      return;
    }
    const bytes = await readFile(new URL("./fixture/" + name, import.meta.url));
    res
      .writeHead(200, {
        "Content-Type": name.endsWith(".pdf") ? "application/pdf" : "text/html",
      })
      .end(bytes);
    return;
  }
  const snapshot = /^\/api\/audits\/snapshots\/([a-f0-9]{64})$/.exec(path);
  if (snapshot && req.method === "GET") {
    try {
      const bytes = await readFile(
        directory + "/snapshots/" + snapshot[1] + ".pdf",
      );
      res.writeHead(200, { "Content-Type": "application/pdf" }).end(bytes);
    } catch {
      res.writeHead(404).end();
    }
    return;
  }
  res.setHeader("Content-Type", "application/json");
  db ??= openStore();
  if (path === "/api/audits/362" && req.method === "GET") {
    const job = db
      .prepare(
        "SELECT id,status,attempted,attempts,error,review_date,year FROM jobs WHERE hospital='362' ORDER BY id DESC LIMIT 1",
      )
      .get();
    res.end(JSON.stringify({ job: job ?? null, latest: history(db, "362") }));
    return;
  }
  const match = /^\/api\/audits\/362\/(2025|2026)$/.exec(path);
  if (match && req.method === "POST") {
    const hosts = ["127.0.0.1:" + port, "localhost:" + port];
    if (
      !hosts.includes(req.headers.host) ||
      (req.headers.origin &&
        !hosts.some((h) => "http://" + h === req.headers.origin)) ||
      req.headers["x-audit-request"] !== "1"
    ) {
      res.writeHead(403).end("{}");
      return;
    }
    res
      .writeHead(202)
      .end(JSON.stringify({ id: enqueue(db, Number(match[1])) }));
    return;
  }
  res.writeHead(404).end("{}");
}
