// Single fetch wrapper for every API call in frontend_2.
// Same contract as the old app: relative /api/* paths (Vite proxies to
// backend_2 in dev), errors thrown as plain Error with a human message.
const BASE = import.meta.env.VITE_API_BASE_URL ?? "";

async function request(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, options);
  if (!response.ok) {
    // Surface the server's error message when it has one, like the old
    // app's reviewRequest did (the review form shows 400/409 messages).
    let message = "Request failed.";
    try {
      const data = await response.json();
      if (data?.error) message = data.error;
    } catch { /* keep the default message */ }
    throw new Error(message);
  }
  return response.json();
}

export function getJson(path, signal) {
  return request(path, { signal });
}

// Liveness check used by the Phase 0 shell to prove the proxy works.
export function health(signal) {
  return request("/api/health", { signal });
}

// Audit-panel rechecks carry a different guard from review writes:
// X-Audit-Request: 1 and NO body (see AuditController).
export function auditRequest(path) {
  return request(path, {
    method: "POST",
    headers: { "X-Audit-Request": "1" },
  });
}

// Review-inbox writes carry the same guard as the old app:
// same-origin POST plus the x-review-request header (see ReviewController).
export function reviewRequest(path, body) {
  return request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-review-request": "1" },
    body: JSON.stringify(body),
  });
}
