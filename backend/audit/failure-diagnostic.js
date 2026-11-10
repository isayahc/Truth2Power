// Safe, structured failure metadata shared by persistence and public reporting.
import { isIP } from 'node:net';

const messages = {
  website_verification_required: 'Human intervention required: website verification.',
  source_host_blocked: 'Source URL is outside discovery scope or is not valid HTTPS.',
  unsafe_destination: 'Source resolves to a private or internal address. Retrieval blocked.',
  redirect_loop: 'Source redirect loop detected.',
  redirect_limit: 'Source exceeded the redirect limit.',
  tls_certificate_invalid: 'TLS certificate verification failed. Check the worker trust store and website certificate chain.',
  http_error: 'The website returned an HTTP error.',
  collection_failed: 'Source collection failed. A specific cause was not recorded.',
};

export function failureDiagnostic(code, metadata = {}) {
  if (!Object.hasOwn(messages, code ?? '')) return null;
  metadata ??= {};
  const http_status = ['http_error','website_verification_required'].includes(code) && Number.isInteger(metadata.http_status) && metadata.http_status >= 400 && metadata.http_status <= 599 ? metadata.http_status : null;
  let source_url = null;
  try {
    const u = new URL(metadata.source_url);
    if (u.protocol === 'https:' && !u.username && !u.password && !u.port && !isIP(u.hostname) &&
        /^[a-z0-9.-]+\.[a-z]+$/i.test(u.hostname) && !/\.(local|internal|localhost)$/.test(u.hostname) && u.hostname !== 'metadata.google.internal' && u.href.length <= 4096) {
      u.search = ''; u.hash = ''; source_url = u.href;
    }
  } catch { /* Untrusted or absent source metadata. */ }
  const retryable = code === 'collection_failed' || (code === 'http_error' && (http_status === null || http_status === 408 || http_status === 429 || http_status >= 500));
  return { code, message: messages[code], http_status, source_url,
    manifest_id: /^[a-f0-9]{32}$/.test(metadata.manifest_id ?? '') ? metadata.manifest_id : null,
    retryable };
}
