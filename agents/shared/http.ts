export async function fetchPublicSource(sourceUrl: string, maxBytes = 25 * 1024 * 1024) {
  const signal = AbortSignal.timeout(45_000)
  let url = new URL(sourceUrl)
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("Source must be an HTTPS URL without credentials")
    const response = await fetch(url, { redirect: "manual", signal })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location")
      await response.body?.cancel()
      if (!location || redirects === 5) throw new Error("Invalid or excessive redirects")
      url = new URL(location, url)
      continue
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`) }
    if (!response.body) throw new Error("Empty response")
    const chunks: Uint8Array[] = []
    let size = 0
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > maxBytes) throw new Error("Source exceeds download size limit")
      chunks.push(chunk)
    }
    return { bytes: Buffer.concat(chunks), url: url.href, status: response.status,
      contentType: response.headers.get("content-type") ?? "", retrievedAt: new Date().toISOString() }
  }
  throw new Error("Redirect limit exceeded")
}
