"""Synthetic fixtures exercise extraction, evidence integrity and human-review routing."""
import hashlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from pypdf import PdfWriter
from extraction import extract_bytes, extract_collection


def text_pdf():
    from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject
    writer = PdfWriter()
    page = writer.add_blank_page(width=612, height=792)
    font = DictionaryObject({NameObject('/Type'): NameObject('/Font'),
                             NameObject('/Subtype'): NameObject('/Type1'),
                             NameObject('/BaseFont'): NameObject('/Helvetica')})
    page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)})})
    stream = DecodedStreamObject()
    stream.set_data(b'BT /F1 12 Tf 50 700 Td (SYN-001 Synthetic financial assistance policy text.) Tj ET')
    page[NameObject('/Contents')] = writer._add_object(stream)
    writer.add_blank_page(width=612, height=792)
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


class ExtractionTests(unittest.TestCase):
    def test_html_removes_scripts_and_preserves_unicode(self):
        html = '<head><title>hidden</title></head><script>secret</script><style>hidden</style><p>SYN-001 Financial assistance &amp; ayuda económica.</p>'
        result = extract_bytes(html.encode(), '.html')[0]
        self.assertEqual(result['status'], 'extracted')
        self.assertIn('ayuda económica', result['text'])
        self.assertNotIn('secret', result['text'])
        self.assertNotIn('hidden', result['text'])

    def test_pdf_keeps_pages_and_flags_blank_page(self):
        result = extract_bytes(text_pdf(), '.pdf')
        self.assertEqual([s['locator'] for s in result], ['page 1', 'page 2'])
        self.assertEqual([s['status'] for s in result], ['extracted', 'needs_review'])
        self.assertIn('SYN-001', result[0]['text'])

    def test_invalid_pdf(self):
        with self.assertRaises(ValueError):
            extract_bytes(b'not pdf', '.pdf')

    def test_encrypted_pdf_requires_review(self):
        writer = PdfWriter()
        writer.add_blank_page(width=612, height=792)
        writer.encrypt('synthetic-password')
        output = io.BytesIO()
        writer.write(output)
        with self.assertRaisesRegex(ValueError, 'encrypted_pdf'):
            extract_bytes(output.getvalue(), '.pdf')

    def test_rejects_path_traversal(self):
        with self.assertRaises(ValueError):
            extract_collection('../1002', 'a' * 32, Path('.'), lambda p, d: None)

    def test_manifest_flags_missing_and_tampered_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def save(path, data):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
            html = b'<p>SYN-001 Synthetic financial assistance information.</p>'
            digest = hashlib.sha256(html).hexdigest()
            snap = f'snapshots/{digest}.html'
            save(root / snap, html)
            cid = 'a' * 32
            manifest = {'hospital_key': '1002', 'landing_url': 'https://example.org',
                        'landing_page': {'url': 'https://example.org', 'sha256': digest, 'artifact_path': snap},
                        'documents': [{'source_url': 'https://example.org/missing.pdf', 'status': 'failed', 'http_status': 404}]}
            save(root / f'collections/1002/{cid}.json', json.dumps(manifest).encode())
            result = extract_collection('1002', cid, root, save)
            self.assertEqual(result['review_count'], 1)
            saved = json.loads(Path(result['manifest_file']).read_text())
            self.assertEqual(saved['documents'][1]['reason'], 'source_not_downloaded')
            self.assertTrue((root / saved['documents'][0]['text_path']).exists())
            save(root / snap, b'tampered')
            second = extract_collection('1002', cid, root, save)
            self.assertEqual(second['review_count'], 2)
            self.assertNotEqual(second['manifest_file'], result['manifest_file'])
            self.assertEqual(json.loads(Path(second['manifest_file']).read_text())['documents'][0]['reason'], 'snapshot_hash_mismatch')


if __name__ == '__main__':
    unittest.main()
