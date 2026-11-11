// Safe, structured failure metadata shared by persistence and public reporting.
import { isIP } from 'node:net';

const messages = {
  website_verification_required: 'Human intervention required: website verification.',
  off_host_document_blocked: 'The collector blocked a hospital-linked file because it was hosted on another domain.',
  source_host_blocked: 'Source URL is outside discovery scope or is not valid HTTPS.',
  unsafe_destination: 'Source resolves to a private or internal address. Retrieval blocked.',
  redirect_loop: 'Source redirect loop detected.',
  redirect_limit: 'Source exceeded the redirect limit.',
  tls_certificate_invalid: 'TLS certificate verification failed. Check the worker trust store and website certificate chain.',
  dns_resolution_failed: 'The worker could not resolve the website hostname. Check DNS from the worker.',
  retrieval_timeout: 'The website did not respond before the retrieval deadline.',
  invalid_document: 'The response did not contain a valid PDF or Word document.',
  invalid_content: 'The response did not contain the expected page.',
  resource_limit: 'The collection reached a resource limit.',
  http_error: 'The website returned an HTTP error.',
  collection_failed: 'Source collection failed. A specific cause was not recorded.',
};

export function failureDiagnostic(code, metadata = {}) {
  if (!Object.hasOwn(messages, code ?? '')) return null;
  metadata ??= {};
  const http_status = ['http_error','website_verification_required'].includes(code) && Number.isInteger(metadata.http_status) && metadata.http_status >= 400 && metadata.http_status <= 599 ? metadata.http_status : null;
  const source_url = publicSourceUrl(metadata.source_url);
  const retryable = ['collection_failed','dns_resolution_failed','retrieval_timeout'].includes(code) || (code === 'http_error' && (http_status === null || http_status === 408 || http_status === 429 || http_status >= 500));
  return { code, message: messages[code], http_status, source_url,
    manifest_id: /^[a-f0-9]{32}$/.test(metadata.manifest_id ?? '') ? metadata.manifest_id : null,
    retryable };
}

/** Remove credentials, query strings, fragments and local destinations from run diagnostics. */
function publicSourceUrl(value) {
  let source_url = null;
  try {
    const u = new URL(value);
    if (u.protocol === 'https:' && !u.username && !u.password && !u.port && !isIP(u.hostname) &&
        /^[a-z0-9.-]+\.[a-z]+$/i.test(u.hostname) && !/\.(local|internal|localhost)$/.test(u.hostname) && u.hostname !== 'metadata.google.internal' && u.href.length <= 4096) {
      u.search = ''; u.hash = ''; source_url = u.href;
    }
  } catch { /* Untrusted or absent source metadata. */ }
  return source_url;
}

/** Project only public metadata from a saved manifest, including older same-host failures. */
export function documentAttempts(collection) {
  return (collection.documents ?? []).map(doc => {
    const saved = doc.status === 'saved';
    const source_url = publicSourceUrl(doc.source_url), parent_url = publicSourceUrl(doc.parent_url);
    let reason = null;
    if (!saved) {
      const code = doc.error_code ?? doc.reason;
      if (Object.hasOwn(messages, code)) reason = code;
      else if (doc.http_status) reason = 'http_error';
      else if (doc.error_type === 'SourceBoundaryError') reason = 'source_host_blocked';
      else if (doc.error_type === 'gaierror') reason = 'dns_resolution_failed';
      else if (doc.error_type === 'TimeoutError') reason = 'retrieval_timeout';
      else if (/limit reached/i.test(doc.reason ?? '')) reason = 'resource_limit';
      else reason = 'collection_failed';
      if (reason === 'source_host_blocked' && doc.reason === "Document or redirect is outside the roster site's HTTPS host" &&
          !doc.redirects?.length && parent_url && source_url && new URL(parent_url).hostname !== new URL(source_url).hostname) {
        reason = 'off_host_document_blocked';
      }
    }
    return {
      source_url, parent_url,
      ...(reason === 'resource_limit' && ['depth', 'pages', 'documents', 'seconds', 'bytes_per_resource',
        'total_bytes', 'network_bytes', 'network_requests'].includes(doc.limit) ? { limit: doc.limit } : {}),
      status: saved ? 'saved' : 'failed', reason,
      http_status: failureDiagnostic(reason, doc)?.http_status ?? null,
      sha256: saved && /^[0-9a-f]{64}$/.test(doc.sha256) ? doc.sha256 : null,
    };
  });
}
