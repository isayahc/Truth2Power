"""Synthetic auxiliary-part coverage, citation and unknown-field regressions."""
import io
import unittest
import zipfile

from extraction import extract_bytes
from test_docx import docx

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'


def with_parts(parts):
    out = io.BytesIO(docx())
    with zipfile.ZipFile(out, 'a') as archive:
        for name, content in parts.items():
            archive.writestr('word/' + name, content)
    return out.getvalue()


class AuxiliaryTests(unittest.TestCase):
    def test_footnotes_headers_and_page_fields_are_individually_cited(self):
        raw = with_parts({
            'footnotes.xml': f'<w:footnotes xmlns:w="{W}"><w:footnote w:id="1"><w:p><w:r><w:t>SYN primary-language definition is retained exactly.</w:t></w:r></w:p></w:footnote></w:footnotes>',
            'header1.xml': f'<w:hdr xmlns:w="{W}"><w:p><w:r><w:t>SYN hospital assistance header text.</w:t></w:r></w:p></w:hdr>',
            'footer1.xml': f'<w:ftr xmlns:w="{W}"><w:p><w:r><w:instrText> PAGE </w:instrText></w:r></w:p></w:ftr>',
            'endnotes.xml': f'<w:endnotes xmlns:w="{W}"/>',
        })
        parts = extract_bytes(raw, '.docx')
        self.assertEqual(len(parts), 5)
        self.assertTrue(all(p['status'] == 'extracted' for p in parts))
        footnote = next(p for p in parts if 'word/footnotes.xml' in p['locator'])
        self.assertEqual(footnote['text'], 'SYN primary-language definition is retained exactly.')
        footer = next(p for p in parts if 'word/footer1.xml' in p['locator'])
        self.assertTrue(footer['empty_auxiliary_part'])
        self.assertEqual(footer['fields'], ['PAGE'])
        self.assertIn('pagination unverified', footer['locator'])

    def test_unknown_fields_images_and_malformed_roots_are_not_cleared(self):
        for content in [f'<w:ftr xmlns:w="{W}"><w:p><w:r><w:instrText>INCLUDETEXT https://example.org/SYN</w:instrText></w:r></w:p></w:ftr>',
                        f'<w:ftr xmlns:w="{W}"><w:p><w:drawing/></w:p></w:ftr>', '<unexpected/>']:
            parts = extract_bytes(with_parts({'footer1.xml': content}), '.docx')
            self.assertEqual(parts[-1]['status'], 'needs_review')

    def test_auxiliary_xml_entities_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'declarations'):
            extract_bytes(with_parts({'footnotes.xml': '<!DOCTYPE x [<!ENTITY y "SYN">]><x/>'}), '.docx')
