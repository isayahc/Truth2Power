import { createServer } from "node:http";
import { access, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { handler } from "./handler.js";

import { auditRoute } from "../audit/routes.js";

const development = process.argv.includes("--dev");
const port = Number(process.env.PORT ?? 8000);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT must be between 1 and 65535.");

const dist = fileURLToPath(new URL("../../dist/", import.meta.url));
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
};
const headers = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
};
const appPaths = new Set(["/", "/index.html", "/maps", "/maps/"]);
let vite;

/** Serve the React entry point or one of the generated build assets. */
async function serveBuild(path, req, res) {
  const file = appPaths.has(path) ? "/index.html" : path;
  if (file !== "/index.html" && !/^\/assets\/[\w.-]+\.(js|css)$/.test(file)) {
    res.writeHead(404).end();
    return;
  }
  try {
    const bytes = await readFile(join(dist, file));
    res.writeHead(200, {
      "Content-Type": types[extname(file)] + "; charset=utf-8",
    });
    res.end(req.method === "HEAD" ? undefined : bytes);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    res.writeHead(404).end();
  }
}

const server = createServer(async (req, res) => {
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  try {
    const path = (req.url ?? "/").split("?", 1)[0];
    if (path.startsWith("/api/audits/") || path.startsWith("/audit-demo/")) {
      await auditRoute(req, res, path, port);
    } else if (path === "/api" || path.startsWith("/api/")) {
      let body;
      if ((path.startsWith('/api/criteria/') || path.startsWith("/api/reviews/") || path.startsWith("/api/pilot/") || /^\/api\/hospitals\/[^/]+\/criteria(?:\/|$)/.test(path)) && req.method === "POST") {
        const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
        if (!hosts.includes(req.headers.host) || req.headers["x-review-request"] !== "1" ||
            (req.headers.origin && !hosts.some((host) => req.headers.origin === `http://${host}`))) {
          res.writeHead(403).end();
          return;
        }
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
            const limit = /^\/api\/pilot\/v1\/runs\/audit-run-[1-9]\d*\/intervention\/documents$/.test(path) ? 6 * 1024 * 1024 : 8192;
            if (size > limit) { res.writeHead(413).end(); return; }
          chunks.push(chunk);
        }
        body = Buffer.concat(chunks).toString("utf8");
      }
      const result = await handler({
        rawPath: path,
        queryStringParameters: Object.fromEntries(new URL(req.url, "http://localhost").searchParams),
        headers: req.headers,
        body,
        requestContext: { http: { method: req.method } },
      });
      res.writeHead(result.statusCode, result.headers).end(result.isBase64Encoded ? Buffer.from(result.body, "base64") : result.body);
    } else if (!["GET", "HEAD"].includes(req.method)) {
      res.writeHead(405, { Allow: "GET, HEAD" }).end();
    } else if (development) {
      if (appPaths.has(path)) req.url = "/index.html";
      vite.middlewares(req, res, () => res.writeHead(404).end());
    } else {
      await serveBuild(path, req, res);
    }
  } catch (error) {
    console.error("request_failed", error.code ?? error.name);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

if (development) {
  const { createServer: createVite } = await import("vite");
  vite = await createVite({ server: { middlewareMode: true, ws: { server } } });
} else {
  try {
    await access(join(dist, "index.html"));
  } catch {
    throw new Error(
      "Build the React app with npm run build before running npm start.",
    );
  }
}
server.on("error", (error) => {
  console.error("Could not start the local server:", error.code);
  process.exit(1);
});
server.listen(port, "127.0.0.1", () =>
  console.log("Truth2Power is running at http://127.0.0.1:" + port + "/"),
);
