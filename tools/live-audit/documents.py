"""Bounded hospital-page traversal and retrieval of directly published documents."""
from run_budget import current, BudgetStop
from usage import measured, usage
import hashlib
import json
import re
import uuid
import io
import zipfile
import socket
import ssl
import ipaddress
import http.client
import time
import threading
import queue as queues
from heapq import heappop, heappush
from itertools import count
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import ExitStack, nullcontext
from contextvars import copy_context
from typing import Callable
from dataclasses import dataclass, asdict, replace
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urldefrag, urljoin, urlsplit, urlunsplit
from urllib.error import HTTPError

LIMIT = 12 * 1024 * 1024
MAX_DOCUMENTS = 100
DOWNLOAD_WORKERS = 4


def now():
    return datetime.now(timezone.utc).isoformat()


def normalize_url(url):
    """Drop fragments and canonicalize HTTPS authority only; keep path case and query order."""
    url = urldefrag(url)[0]
    p = urlsplit(url)
    if p.scheme == 'https' and not p.username and not p.password and p.hostname:
        authority = ('[' + p.hostname + ']') if ':' in p.hostname else p.hostname
        if p.port not in {None, 443}:
            authority += ':' + str(p.port)
        return urlunsplit((p.scheme, authority, p.path or '/', p.query, ''))
    return url


class Links(HTMLParser):
    """Keep document anchors, including duplicate labels and languages."""
    def __init__(self, base, all_links=False):
        super().__init__()
        self.base, self.links, self.current = base, {}, None
        self.file_anchors: set[str] = set()
        self.all_links = all_links
        self.truncated = False
        self.base_seen = False
        self.late_base = False

    def handle_starttag(self, tag, attrs):
        if tag == "base" and not self.base_seen and dict(attrs).get("href"):
            if self.links:
                # Do not certify earlier anchors using a base that the browser would replace.
                self.links.clear()
                self.file_anchors.clear()
                self.late_base = True
            self.base_seen = True
            self.base = urljoin(self.base, dict(attrs)["href"])
        if tag == "a":
            attributes = dict(attrs)
            href = attributes.get("href") or ""
            try:
                url = normalize_url(urljoin(self.base, href))
            except ValueError:
                self.current = None
                return
            declared_file = "download" in attributes or attributes.get("type") in {
                "application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}
            self.current = (url, [], declared_file) if self.all_links or urlsplit(url).path.lower().endswith((".pdf", ".docx")) else None

    def handle_data(self, text):
        if self.current:
            self.current[1].append(text)

    def handle_endtag(self, tag):
        if tag == "a" and self.current:
            url, text, declared_file = self.current
            if self.all_links and len(self.links) >= 5000 and url not in self.links:
                self.truncated = True
            else:
                if declared_file:
                    self.file_anchors.add(url)
                self.links.setdefault(url, []).append(" ".join("".join(text).split()))
            self.current = None


DOCUMENT_SUFFIXES = {".pdf", ".docx"}
HTML_TYPES = {"text/html", "application/xhtml+xml"}
DOCUMENT_HINT = re.compile(
    r"\b(?:pdf|docx|download|application form|financial assistance application|policy summary|"
    r"plain language summary|assistance policy|poverty guidelines)\b", re.I
)


def document_hint(url: str, labels: list[str]) -> bool:
    """Permit a terminal file request for explicit file links and labeled download endpoints."""
    path = urlsplit(url).path
    return Path(path).suffix.lower() in DOCUMENT_SUFFIXES or bool(
        DOCUMENT_HINT.search(" ".join([path.replace("/", " ").replace("-", " ").replace("_", " "), *labels]))
    )


# These terms order already-eligible links. They confer neither retrieval authority
# nor document role or campus applicability. Other candidates remain in the queue.
AID_TOPIC = re.compile(
    r"\b(?:financial (?:assistance|aid|help)|charity care|fap|fpl|"
    r"plain language summary|(?:federal )?poverty (?:level|guidelines?)|fa guidelines?|"
    r"asistencia (?:financiera|económica)|ayuda (?:financiera|económica))\b", re.I
)


DISCOVERY_TOPIC = re.compile(
    r"financial|assistance|charity|plain.language|documents|resources|/docs/|application|billing|"
    r"patients?[/ _&-]*(?:and[/ _&-]*)?(?:visitors?|information|services)|asistencia|ayuda", re.I
)


def crawl_priority(url: str, labels: list[str], file_hint: bool, depth: int, max_depth: int,
                   discovery_page: bool = True) -> tuple[bool, int, int, bool]:
    """Visit explicit aid evidence and potential discovery pages before incidental files."""
    path = unquote(urlsplit(url).path)
    # Use the filename for a file. An aid directory can also contain unrelated PDFs.
    name = path.rstrip("/").rsplit("/", 1)[-1] if file_hint else path
    words = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", " ".join([name, *labels]))
    signal = re.sub(r"[\W_]+", " ", words)
    aid = bool(AID_TOPIC.search(signal))
    if file_hint and aid:
        group = 0
    elif not file_hint and discovery_page:
        group = 1
    elif file_hint:
        group = 2
    else:
        group = 3
    return (depth > max_depth, group, depth, not aid)


def document_suffix(data: bytes, expected: str) -> str:
    """Check the response bytes before recording a PDF or Word document capture."""
    if data.startswith(b"%PDF-") and expected != ".docx":
        return ".pdf"
    if data.startswith(b"PK") and expected != ".pdf":
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                if "word/document.xml" in archive.namelist():
                    return ".docx"
        except zipfile.BadZipFile:
            pass
    raise SourceBoundaryError("Response was not the linked PDF or DOCX", "invalid_document")


def public_ip(value):
    address = ipaddress.ip_address(value)
    return address.is_global and not address.is_multicast and not address.is_reserved


class SourceBoundaryError(ValueError):
    code = "source_host_blocked"

    def __init__(self, message: str, code: str = "source_host_blocked", *, limit: str | None = None) -> None:
        """Keep the public failure category and the specific limit when known."""
        super().__init__(message)
        self.code = code
        self.limit = limit


def approved(url, host):
    parsed = urlsplit(url)
    if (parsed.scheme != "https" or parsed.hostname not in {host, "www." + host}
            or parsed.port not in {None, 443} or parsed.username or parsed.password
            or len(url) > 4096 or any(ord(c) < 33 for c in url) or "\\" in url):
        raise SourceBoundaryError("Document or redirect is outside the roster site's HTTPS host")
    if (not re.fullmatch(r"[a-z0-9.-]+\.[a-z]+", parsed.hostname or "", re.I)
            or parsed.hostname == "metadata.google.internal"
            or parsed.hostname.endswith((".local", ".internal", ".localhost"))):
        raise SourceBoundaryError("Internal hostname or literal address prohibited", "unsafe_destination")
    return url


@dataclass(frozen=True)
class Bounds:
    depth: int = 3
    pages: int = 20
    documents: int = 100
    bytes_per_resource: int = LIMIT
    total_bytes: int = 64 * 1024 * 1024
    timeout: int = 20
    seconds: int = 480
    redirects: int = 5

    def __post_init__(self):
        caps = dict(depth=8, pages=100, documents=100, bytes_per_resource=LIMIT,
                    total_bytes=128 * 1024 * 1024, timeout=30, seconds=3600, redirects=8)
        if any(type(v) is not int or v < 1 or v > caps[k] for k, v in asdict(self).items()):
            raise ValueError("Invalid traversal limits")


def public_addresses(host, timeout=20):
    # Native getaddrinfo has no timeout argument; a daemon lookup cannot hold the worker open.
    result = queues.Queue(maxsize=1)
    def lookup():
        try:
            result.put(socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM))
        except Exception as error:
            result.put(error)
    threading.Thread(target=lookup, daemon=True).start()
    try:
        rows = result.get(timeout=timeout)
    except queues.Empty:
        raise TimeoutError("DNS deadline reached") from None
    if isinstance(rows, Exception):
        raise rows
    addresses = sorted({row[4][0] for row in rows})
    if not addresses or any(not public_ip(a) for a in addresses):
        raise SourceBoundaryError("DNS resolved to a non-public address", "unsafe_destination")
    return addresses


class PinnedConnections:
    """Reuse a few idle TLS connections only for the same hostname and validated IP."""

    def __init__(self) -> None:
        """Scope the TLS context and idle sockets to one collection."""
        self.tls = ssl.create_default_context()
        self.idle: list[tuple[tuple[str, str], http.client.HTTPSConnection]] = []
        self.lock = threading.Lock()

    def take(self, key: tuple[str, str]) -> http.client.HTTPSConnection | None:
        """Give the caller exclusive ownership of a matching live connection."""
        with self.lock:
            for index in range(len(self.idle) - 1, -1, -1):
                if self.idle[index][0] == key:
                    return self.idle.pop(index)[1]
        return None

    def put(self, key: tuple[str, str], connection: http.client.HTTPSConnection) -> None:
        """Return a fully consumed HTTP connection or close the oldest idle one."""
        with self.lock:
            self.idle.append((key, connection))
            if len(self.idle) > DOWNLOAD_WORKERS:
                self.idle.pop(0)[1].close()

    def close(self) -> None:
        """Close all idle sockets after the download pool has drained."""
        for _, connection in self.idle:
            connection.close()
        self.idle.clear()


def download(url: str, host: str, bounds: Bounds | None = None, trace: list | None = None,
             connections: PinnedConnections | None = None, crawl_deadline: float | None = None) -> tuple[bytes, str, str]:
    """Fetch through a validated public IP with a single deadline across redirects."""
    budget = current.get()
    with budget.downloader() if budget else nullcontext():
        return _download(url, host, bounds or Bounds(), trace, connections, crawl_deadline)


def _download(url: str, host: str, bounds: Bounds, trace: list | None,
              connections: PinnedConnections | None, crawl_deadline: float | None) -> tuple[bytes, str, str]:
    """Verify each hop, meter each GET, and close every incomplete response."""
    deadline = time.monotonic() + bounds.timeout
    if crawl_deadline is not None:
        deadline = min(deadline, crawl_deadline)
    approved(url, host)
    seen = set()
    budget = current.get()
    for hop in range(bounds.redirects + 1):
        if url in seen:
            raise SourceBoundaryError("Redirect loop detected", "redirect_loop")
        seen.add(url)
        parsed = urlsplit(url)
        approved(url, (parsed.hostname or '').removeprefix('www.'))
        if budget:
            budget.reserve("network_requests", 0)
            budget.reserve("network_bytes", 0)
        address = public_addresses(parsed.hostname, max(0.001, deadline - time.monotonic()))[0]
        key = (parsed.hostname, address)
        connection = connections.take(key) if connections else None
        response = None
        try:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("Download deadline reached")
                reused = connection is not None
                if reused:
                    connection.sock.settimeout(remaining)
                else:
                    connection = http.client.HTTPSConnection(parsed.hostname, timeout=remaining)
                    context = connections.tls if connections else ssl.create_default_context()
                    sock = socket.create_connection((address, 443), timeout=remaining)
                    try:
                        connection.sock = context.wrap_socket(sock, server_hostname=parsed.hostname)
                    except BaseException:
                        sock.close()
                        raise
                if budget:
                    budget.reserve("network_requests")
                measured("network_requests")
                try:
                    connection.request("GET", parsed.path + ("?" + parsed.query if parsed.query else "") or "/",
                                       headers={"User-Agent": "Truth2Power public document collection", "Accept-Encoding": "identity"})
                    response = connection.getresponse()
                    break
                except (http.client.RemoteDisconnected, BrokenPipeError, ConnectionResetError):
                    # A server can close an idle keep-alive socket. Retry this GET once.
                    if not reused:
                        raise
                    connection.close()
                    connection = None
            if response.status in {301, 302, 303, 307, 308}:
                target = urldefrag(urljoin(url, response.getheader("Location", "")))[0]
                approved(target, (urlsplit(target).hostname or '').removeprefix('www.'))
                if trace is not None:
                    trace.append(dict(source_url=url, final_url=target, http_status=response.status))
                url = target
                continue
            if response.status != 200:
                raise HTTPError(url, response.status, "Resource unavailable", response.headers, None)
            if isinstance(response.length, int) and response.length > bounds.bytes_per_resource:
                raise SourceBoundaryError("Resource byte limit reached", "resource_limit", limit="bytes_per_resource")
            chunks, size = [], 0
            while response.length != 0:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("Download deadline reached")
                if connection.sock:
                    connection.sock.settimeout(remaining)
                chunk_size = min(65536, bounds.bytes_per_resource + 1 - size)
                part = budget.read(response, chunk_size) if budget else response.read1(chunk_size)
                if not part:
                    if isinstance(response.length, int) and response.length > 0:
                        raise http.client.IncompleteRead(b"")
                    break
                chunks.append(part)
                measured("network_bytes", len(part))
                size += len(part)
                if size > bounds.bytes_per_resource:
                    raise SourceBoundaryError("Resource byte limit reached", "resource_limit", limit="bytes_per_resource")
            response.close()
            if connections and not response.will_close and connection.sock:
                connections.put(key, connection)
                connection = None
            return b"".join(chunks), url, response.headers.get_content_type()
        finally:
            if connection:
                if response is not None:
                    response.close()
                connection.close()
    raise SourceBoundaryError("Redirect limit reached", "redirect_limit")



def collect(hospital_key: str, root: Path, output: Path, save: Callable, fetch: Callable = download,
            bounds: Bounds | None = None, on_capture: Callable[[dict], None] | None = None) -> dict:
    """Persist an immutable attempt manifest, including failures and source URLs."""
    if not re.fullmatch(r"(?:\d{1,8}|t2p-\d{1,8})", hospital_key):
        raise ValueError("Use a hospital key from the roster")
    roster = json.loads((root / "data/maps/hospitals.geojson").read_text(encoding="utf-8"))
    facility = next((f for f in roster["features"] if str(f["id"]) == hospital_key), None)
    if facility is None:
        raise ValueError("Hospital is not in the roster")
    url = facility["properties"]["assistance_url"]
    host = (urlsplit(url).hostname or "").removeprefix("www.")
    bounds = bounds or Bounds()
    inventory_path = root / "docs/audit-format/wave-one-document-inventory.json"
    known = []
    if inventory_path.exists():
        inventory = json.loads(inventory_path.read_bytes())
        known = [dict(d, hospital_key=h['hospital_key']) for h in inventory['hospitals'] for d in h['documents'] if d.get('status') == 'content_confirmed']
    summary_path = root / "docs/audit-format/changes/362-summary-posting.json"
    if summary_path.exists():
        summary = json.loads(summary_path.read_bytes())
        language_path = root / "docs/audit-format/summaries/362.json"
        languages = (json.loads(language_path.read_bytes())['assessment']['findings'][0]['observed']['documents']
                     if language_path.exists() else [])
        known += [dict(sha256=s['sha256'], type=s['document_type'], hospital_key=summary['hospital_key'],
                       language_label=next((d['language'] for d in languages if d['snapshot_id'] == s['snapshot_id']), 'und'),
                       evidence=[dict(locator=e['locator'], quote=e['quote']) for e in summary['assessment']['findings'][0]['evidence'] if e['snapshot_id'] == s['snapshot_id']])
                  for s in summary['snapshots'] if s['document_type'] == 'policy_summary']
    attempt = dict(schema_version="1.0", hospital_key=hospital_key, landing_url=url,
                   attempted_at=now(), status="failed", landing_page=None, documents=[],
                    pages=[], links=[], bounds=asdict(bounds),
                    limitations=["Bounded HTML-anchor traversal is not an exhaustive absence search. JavaScript-only resources require review; scripts are never executed. "
                                  "HTTPS server redirects are followed with public-IP-pinned TLS. HTML traversal stays on the roster or migrated landing host. Verified pages may link to terminal documents hosted elsewhere. Retrieval does not establish campus, role or language."])

    def snapshot(data, final_url, suffix, mime):
        digest = hashlib.sha256(data).hexdigest()
        path = Path("snapshots") / (digest + suffix)
        save(output / path, data)
        return dict(url=final_url, sha256=digest, artifact_path=path.as_posix(),
                    retrieved_at=now(), publisher_updated_at=None, content_type=mime, size_bytes=len(data))

    order = count()
    queue = [(crawl_priority(url, [], False, 0, bounds.depth), next(order), (url, [], 0, None, False))]
    visited, total = set(), 0
    counts = {"pages": 0, "documents": 0}

    def reserve(kind: str) -> None:
        """Bound requests before fetching and charge newly identified documents before saving."""
        if counts[kind] >= getattr(bounds, kind):
            raise SourceBoundaryError("Resource count limit reached", "resource_limit", limit=kind)
        if current.get():
            current.get().reserve(kind)
        counts[kind] += 1

    landing_host = host
    started = time.monotonic()

    def failure(record: dict, error: Exception) -> None:
        """Preserve the first run-wide stop reason and each individual failure."""
        if isinstance(error, BudgetStop):
            if "budget_stop" not in attempt:
                attempt["budget_stop"] = str(error)
                attempt["limitations"].append("Run budget stopped collection: " + str(error))
            record.update(reason=str(error), limit=str(error), error_code="resource_limit")
            return
        record["error_type"] = type(error).__name__
        if isinstance(error, socket.gaierror):
            record['error_code'] = 'dns_resolution_failed'
        elif isinstance(error, TimeoutError):
            record['error_code'] = 'retrieval_timeout'
        if isinstance(error, ssl.SSLCertVerificationError):
            record['error_code'] = 'tls_certificate_invalid'
        if isinstance(error, SourceBoundaryError):
            record['error_code'] = error.code
            if error.limit:
                record['limit'] = error.limit
        if isinstance(error, HTTPError):
            record["http_status"] = error.code
            if error.code == 403 and error.headers and error.headers.get('Cf-Mitigated', '').lower() == 'challenge':
                record['error_code'] = 'website_verification_required'
            record["availability"] = "http_gone_not_confirmed_withdrawal" if error.code == 410 else "inaccessible"
        elif isinstance(error, ValueError):
            record["reason"] = str(error)
        if record["source_url"] == url:
            attempt["error_type"] = type(error).__name__
            if isinstance(error, HTTPError):
                attempt["http_status"] = error.code

    def store_response(record: dict, kind: str, data: bytes, destination: str, mime: str) -> None:
        """Validate, snapshot, classify and enqueue links on the coordinator thread."""
        nonlocal landing_host
        source, depth = record["source_url"], record["depth"]
        parent = record.get("published_link")
        suffix = Path(urlsplit(source).path).suffix.lower()
        source_host = (urlsplit(source).hostname or "").removeprefix("www.")
        document_only = suffix in DOCUMENT_SUFFIXES or source_host not in {host, landing_host}
        trace = record["redirects"]
        final_host = (urlsplit(destination).hostname or '').removeprefix('www.')
        approved(destination, final_host if fetch is download else source_host)
        if len(data) > bounds.bytes_per_resource:
            raise SourceBoundaryError("Resource byte limit reached", "resource_limit", limit="bytes_per_resource")
        if total > bounds.total_bytes:
            raise SourceBoundaryError("Traversal byte limit reached", "resource_limit", limit="total_bytes")
        is_document = document_only or mime not in HTML_TYPES or data.startswith((b"%PDF-", b"PK"))
        received_kind = "documents" if is_document else "pages"
        if kind != received_kind and parent:
            attempt[kind].remove(record)
            attempt[received_kind].append(record)
            reserve(received_kind)
        if is_document:
            if not parent:
                raise SourceBoundaryError("Roster landing page did not return HTML", "invalid_content")
            suffix = document_suffix(data, suffix)
        else:
            if source != url and final_host not in {host, landing_host}:
                raise SourceBoundaryError("Redirected HTML is outside the hospital crawl")
            suffix = ".html"
        record.update(snapshot(data, destination, suffix, mime), final_url=destination, redirects=trace, status="saved")
        classified = next((d for d in known if d['sha256'] == record['sha256'] and d['hospital_key'] == hospital_key), None)
        if classified:
            record.update(classification="pinned_campus_inventory", document_type=classified['type'], language=classified['language_label'])
            record['classification_evidence'] = classified.get('evidence', [dict(locator=classified.get('locator'), quote=classified.get('quote'))])
        elif any(d['sha256'] == record['sha256'] for d in known):
            record["classification"] = "other_campus_requires_review"
        if source == url:
            attempt["landing_page"] = dict(record)
            landing_host = (urlsplit(destination).hostname or '').removeprefix('www.')
        if not is_document:
            links = Links(destination, all_links=True)
            links.feed(data.decode("utf-8", errors="replace"))
            if b"<script" in data.lower():
                record["discovery_gap"] = "Scripts not executed; JavaScript-only links may be missing."
            if links.truncated:
                record["link_limit_reached"] = True
                attempt["limitations"].append("5000 unique anchors per page limit reached.")
            if links.late_base:
                record["discovery_gap"] = "Late HTML base element: preceding anchors require review and were not traversed."
            for target, names in links.links.items():
                if len(attempt["links"]) >= 5000:
                    attempt["limitations"].append("5000-link inventory limit reached; remaining anchors not traversed.")
                    break
                parsed = urlsplit(target)
                web_link = parsed.scheme in {"http", "https"}
                file_hint = target in links.file_anchors or document_hint(target, names)
                in_scope = (parsed.hostname or "").removeprefix("www.") in {host, landing_host}
                base_path = urlsplit(destination).path.rstrip("/")
                descendant = parsed.path.startswith(base_path + "/")
                label = " ".join(names)
                discovery_page = bool(base_path and descendant) or bool(
                    DISCOVERY_TOPIC.search(unquote(parsed.path + "?" + parsed.query) + " " + label))
                # A root page links across the whole site. Its generic navigation is
                # still reachable, but shouldn't outrank opaque published documents.
                relevant = web_link and (file_hint or (in_scope and (descendant or DISCOVERY_TOPIC.search(target + " " + label))))
                edge = dict(parent_url=source, parent_sha256=record["sha256"], target_url=target,
                            anchor_label=next((name for name in names if name), ""))
                disposition = "candidate" if relevant else "out_of_scope" if web_link else "non_retrieval"
                attempt["links"].append({**edge, "labels": names, "disposition": disposition})
                if relevant and target not in visited:
                    priority = crawl_priority(target, names, file_hint, depth + 1, bounds.depth, discovery_page)
                    heappush(queue, (priority, next(order), (target, names, depth + 1, edge, file_hint)))

    def retrieve(record: dict, source_host: str, transfer_bounds: Bounds, counters: Counter) -> tuple:
        """Fetch immutable bytes and report transport time even for failed requests."""
        # Each worker owns its usage counter; only the coordinator merges them.
        usage.set(counters)
        record["download_attempted"] = True
        begin = time.perf_counter_ns()
        try:
            source = record["source_url"]
            if fetch is download:
                try:
                    return download(source, source_host, transfer_bounds, record["redirects"], connections,
                                    started + bounds.seconds)
                except TimeoutError as error:
                    if time.monotonic() >= started + bounds.seconds:
                        raise SourceBoundaryError("Traversal time limit reached", "resource_limit", limit="seconds") from error
                    raise
                except SourceBoundaryError as error:
                    if error.limit == "bytes_per_resource" and transfer_bounds.bytes_per_resource < bounds.bytes_per_resource:
                        raise SourceBoundaryError("Traversal byte limit reached", "resource_limit", limit="total_bytes") from error
                    raise
            return fetch(source, source_host)
        finally:
            record["elapsed_ms"] = (time.perf_counter_ns() - begin) // 1_000_000

    with ExitStack() as cleanup:
        connections = PinnedConnections() if fetch is download else None
        if connections:
            cleanup.callback(connections.close)
        pool = cleanup.enter_context(ThreadPoolExecutor(max_workers=DOWNLOAD_WORKERS, thread_name_prefix="hospital-download"))
        while queue and "budget_stop" not in attempt:
            batch = {}
            terminals_only = True
            # Finish a discovery tier before spending remaining capacity on incidental
            # files: its pages can reveal higher-priority aid policies and applications.
            tier = queue[0][0]
            available = bounds.total_bytes - total
            width = min(DOWNLOAD_WORKERS, max(1, available // bounds.bytes_per_resource))
            while queue and queue[0][0] == tier and len(batch) < width and "budget_stop" not in attempt:
                _, _, (source, labels, depth, parent, file_hint) = heappop(queue)
                if source in visited:
                    continue
                visited.add(source)
                parsed = urlsplit(source)
                source_host = (parsed.hostname or "").removeprefix("www.")
                external = source_host not in {host, landing_host}
                kind = "documents" if external or file_hint or Path(parsed.path).suffix.lower() in DOCUMENT_SUFFIXES else "pages"
                record = dict(source_url=source, labels=labels, parent_url=parent["parent_url"] if parent else None,
                              depth=depth, attempted_at=now(), download_attempted=False, status="failed", classification="unverified", redirects=[])
                if parent:
                    record["published_link"] = parent
                attempt[kind].append(record)
                try:
                    if external and (not parent or not file_hint):
                        raise SourceBoundaryError("External HTML is outside the hospital crawl")
                    approved(source, source_host)
                    if depth > bounds.depth:
                        raise SourceBoundaryError("Traversal depth limit reached", "resource_limit", limit="depth")
                    if time.monotonic() - started >= bounds.seconds:
                        raise SourceBoundaryError("Traversal time limit reached", "resource_limit", limit="seconds")
                    if available <= 0:
                        raise SourceBoundaryError("Traversal byte limit reached", "resource_limit", limit="total_bytes")
                    reserve(kind)
                    transfer_bounds = replace(bounds, bytes_per_resource=min(available, bounds.bytes_per_resource))
                    counters = Counter()
                    future = pool.submit(copy_context().run, retrieve, record, source_host, transfer_bounds, counters)
                    batch[future] = (record, kind, counters)
                    terminals_only &= external or Path(parsed.path).suffix.lower() in DOCUMENT_SUFFIXES
                except (ValueError, OSError) as error:
                    failure(record, error)

            # Terminal files can go straight to the analyst in completion order.
            # Commit potential discovery pages in issue order for stable provenance.
            for future in as_completed(batch) if terminals_only else batch:
                record, kind, counters = batch[future]
                try:
                    try:
                        data, destination, mime = future.result()
                    finally:
                        # Include network bytes from incomplete and failed transfers.
                        total += counters.get("network_bytes", 0)
                    if fetch is not download:
                        total += len(data)
                    store_response(record, kind, data, destination, mime)
                except Exception as error:
                    failure(record, error)
                finally:
                    for unit, quantity in counters.items():
                        measured(unit, quantity)
                if on_capture and record["status"] == "saved":
                    on_capture(record)
    if attempt["landing_page"]:
        attempt["status"] = "partial" if any(r["status"] != "saved" for r in attempt["pages"] + attempt["documents"]) or not attempt["documents"] else "complete"
    attempt["bytes_received"] = total
    attempt["completed_at"] = now()
    path = output / "collections" / hospital_key / (uuid.uuid4().hex + ".json")
    save(path, json.dumps(attempt, indent=2, ensure_ascii=False).encode("utf-8"))
    saved = sum(d["status"] == "saved" for d in attempt["documents"])
    report = (f"Hospital {hospital_key}: {saved}/{len(attempt['documents'])} linked documents saved through bounded traversal. "
              f"Collection status: {attempt['status']}.\nLanding page: {url}\nManifest: {path}\n"
              + "\n".join(f"{d['status']}: {d['source_url']}" +
                          (f" ({d['error_type']}, HTTP {d['http_status']})" if "http_status" in d
                           else f" ({d['error_type']})" if "error_type" in d else "")
                          for d in attempt["documents"])
               + "\nLimitations: " + " ".join(attempt["limitations"]))
    return dict(report=report, manifest_file=str(path), output=attempt)
