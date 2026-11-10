"""Synthetic offline HTTPS responses for the real collector. Never opens a socket."""
import io
import json
import sys
import zipfile
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urljoin

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools/live-audit"))
from documents import Bounds, collect
from pipeline_bridge import save


def document() -> bytes:
    """Build a small, fabricated DOCX with citable role and campus text."""
    output = io.BytesIO()
    xml = ('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
           '<w:body><w:p><w:r><w:t>SYN financial assistance policy summary. Applies to '
           'A.O. Fox Memorial Hospital.</w:t></w:r></w:p></w:body></w:document>')
    with zipfile.ZipFile(output, 'w') as archive:
        archive.writestr(zipfile.ZipInfo('word/document.xml'), xml)
    return output.getvalue()


def main() -> None:
    """Run the bounded collector against fixture pages for two real roster identities."""
    request = json.load(sys.stdin)
    key = request['hospital_key']
    features = json.loads((ROOT / 'data/maps/hospitals.geojson').read_bytes())['features']
    landing = next(f['properties']['assistance_url'] for f in features if f['id'] == key)
    other_campus = '3b5149e5b95b27c043114aa6f287d49a2c2c69aa5cab75671ddcb3bd057c9fb8'

    def fetch(url: str, host: str) -> tuple[bytes, str, str]:
        """Return only predeclared synthetic responses and a pinned other-campus document."""
        if url == landing:
            html = ('<p>SYN hospital financial assistance page.</p><a href="/resources">SYN resources</a>' if key in {'739', '1'} else
                    '<script></script><a href="/missing.pdf">SYN application</a>'
                    '<a href="https://other.invalid/policy.pdf">SYN policy</a>')
            return html.encode(), url, 'text/html'
        if url == urljoin(landing, '/resources'):
            return b'<p>SYN public financial assistance materials.</p><a href="/unknown.docx">SYN item</a><a href="/application.docx">SYN other campus</a>', url, 'text/html'
        if url.endswith('/unknown.docx'):
            return document(), url, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        if url.endswith('/application.docx'):
            with zipfile.ZipFile(ROOT / 'docs/validation/pilot-wave-one-evidence.zip') as archive:
                return archive.read(f'snapshots/{other_campus}.docx'), url, 'application/octet-stream'
        raise HTTPError(url, 404, 'SYN missing', {}, None)

    result = collect(key, ROOT, Path(sys.argv[1]), save, fetch=fetch, bounds=Bounds(**request['bounds']))
    print(json.dumps({'collection': result['output']}))


if __name__ == '__main__':
    main()
