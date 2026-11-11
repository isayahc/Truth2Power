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


def scoped_pdf(facility: str) -> bytes:
    """Build a one-page, text-based synthetic policy for the selected roster entry."""
    from pypdf import PdfWriter
    from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject
    writer = PdfWriter()
    page = writer.add_blank_page(width=612, height=792)
    font = DictionaryObject({NameObject('/Type'): NameObject('/Font'),
                             NameObject('/Subtype'): NameObject('/Type1'),
                             NameObject('/BaseFont'): NameObject('/Helvetica')})
    page[NameObject('/Resources')] = DictionaryObject({
        NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)})})
    lines = ["Financial Assistance Policy Summary", f"Applies to {facility}.",
             "Effective: 2026-01-01", "How to apply: submit the application to the billing office.",
             "The primary service area includes the surrounding county."]
    commands = [b"BT /F1 12 Tf 50 720 Td 16 TL"]
    for line in lines:
        commands.append(b"<" + line.encode("latin1").hex().encode() + b"> Tj T*")
    stream = DecodedStreamObject()
    stream.set_data(b"\n".join([*commands, b"ET"]))
    page[NameObject('/Contents')] = writer._add_object(stream)
    output = io.BytesIO()
    writer.write(output)
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
        if request.get("scenario") == "public-files":
            cdn = "https://files.example/" + key
            if url == landing:
                html = (f'<p>Hospital financial assistance publications for patients.</p>'
                        f'<a href="{cdn}/download/summary" download="summary.pdf">Financial assistance policy summary</a>'
                        f'<a href="{cdn}/missing.pdf">Financial assistance application</a>')
                return html.encode(), url, 'text/html'
            if url == cdn + "/download/summary":
                name = next(f['properties']['name'] for f in features if f['id'] == key)
                return scoped_pdf(name), url, 'application/pdf'
            raise HTTPError(url, 404, 'SYN missing', {}, None)
        if url == landing:
            html = ('<p>SYN hospital financial assistance page.</p><a href="/resources">SYN resources</a>' if key in {'739', '1'} else
                    '<script></script><a href="/missing.pdf">SYN application</a>'
                    '<a href="https://other.invalid/policy.pdf">SYN policy</a>')
            return html.encode(), url, 'text/html'
        if url == urljoin(landing, '/resources'):
            return b'<p>SYN public financial assistance materials.</p><a href="https://files.example/unknown.docx">SYN item</a><a href="https://files.example/application.docx">SYN other campus</a>', url, 'text/html'
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
