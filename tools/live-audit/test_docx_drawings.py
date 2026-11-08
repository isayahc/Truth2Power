"""Synthetic adversarial checks for the narrow non-textual line exception."""
import unittest
import base64
import io
import zipfile
from xml.etree import ElementTree as ET

from docx_drawings import NS, text_free_line, line_metadata, text_free_legacy_lines
from extraction import extract_bytes
from test_docx import docx


def line(extra="", properties="", geometry="line"):
    namespaces = " ".join(f'xmlns:{prefix}="{uri}"' for prefix, uri in NS.items())
    return f'''<w:drawing {namespaces}><wp:anchor><wp:docPr id="1" name="SYN signature line" {properties}/>
      <a:graphic><a:graphicData uri="{NS['wps']}"><wps:wsp><wps:cNvCnPr/>
        <wps:spPr><a:prstGeom prst="{geometry}"><a:avLst/></a:prstGeom></wps:spPr>
        <wps:bodyPr/>{extra}
      </wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing>'''


def package(extra="", external=False, additional=False):
    out = io.BytesIO()
    namespaces = " ".join(f'xmlns:{prefix}="{uri}"' for prefix, uri in NS.items())
    with zipfile.ZipFile(out, "w") as archive:
        archive.writestr("[Content_Types].xml", '<Types/>')
        mode = 'TargetMode="External"' if external else ''
        archive.writestr("_rels/.rels", f'<Relationships><Relationship Target="drs/e2oDoc.xml" {mode}/><Relationship Target="drs/downrev.xml"/></Relationships>')
        archive.writestr("drs/e2oDoc.xml", f'<wp:e2oholder {namespaces}><a:graphic><a:graphicData uri="{NS["wps"]}"><wps:wsp><wps:spPr><a:prstGeom prst="line"/></wps:spPr>{extra}</wps:wsp></a:graphicData></a:graphic></wp:e2oholder>')
        archive.writestr("drs/downrev.xml", f'<a:downRevStg xmlns:a="{NS["a"]}" textCheckSum=""><a:bounds l="0"/></a:downRevStg>')
        if additional:
            archive.writestr("unreviewed.xml", "SYN additional content")
    return base64.b64encode(out.getvalue()).decode()


def legacy(extra="", embedded=None):
    namespaces = " ".join(f'xmlns:{prefix}="{uri}"' for prefix, uri in NS.items())
    metadata = f'o:gfxdata="{embedded}"' if embedded is not None else ''
    return f'<w:pict {namespaces}><v:line id="SYN fallback" from="0pt,0pt" to="20pt,0pt" {metadata}/>{extra}</w:pict>'


class DrawingTests(unittest.TestCase):
    def test_legacy_line_metadata_is_inspected_not_ignored(self):
        self.assertTrue(line_metadata(package()))
        good = legacy(embedded=package())
        self.assertTrue(text_free_legacy_lines(ET.fromstring(good)))
        result = extract_bytes(docx('<w:p>' + good + '</w:p>'), ".docx")[0]
        self.assertEqual(result["status"], "extracted")
        self.assertEqual(result["drawings"][0]["classification"], "text_free_legacy_lines")
        for encoded in [package('<a:t>SYN hidden terms</a:t>'), package(external=True), package(additional=True), 'not base64', 'x' * 100001]:
            self.assertFalse(line_metadata(encoded))
            self.assertFalse(text_free_legacy_lines(ET.fromstring(legacy(embedded=encoded))))

    def test_legacy_border_groups_reject_non_line_content(self):
        namespaces = " ".join(f'xmlns:{prefix}="{uri}"' for prefix, uri in NS.items())
        group = f'<w:pict {namespaces}><v:group><v:shape path="m10,20r30,e" filled="f" style="position:absolute;width:30;height:0"><v:path arrowok="t"/></v:shape><w10:wrap anchorx="page"/></v:group></w:pict>'
        self.assertTrue(text_free_legacy_lines(ET.fromstring(group)))
        for xml in [group.replace('r30,e', 'r30,30e'), group.replace('filled="f"', 'filled="t"'),
                    group.replace('<v:path ', '<v:textbox/><v:path '),
                    group.replace('position:absolute', 'background:url(image.png)'),
                    legacy('<v:imagedata/>'), legacy('<v:textbox>SYN terms</v:textbox>')]:
            self.assertFalse(text_free_legacy_lines(ET.fromstring(xml)))

    def test_two_line_drawings_keep_evidence_and_allow_body_text(self):
        data = docx('<w:p>' + line() + '</w:p><w:p>' + line() + '</w:p>')
        first = extract_bytes(data, ".docx")[0]
        second = extract_bytes(data, ".docx")[0]
        self.assertEqual(first["status"], "extracted")
        self.assertEqual(len(first["drawings"]), 2)
        self.assertEqual(first["drawings"], second["drawings"])
        self.assertEqual({d["classification"] for d in first["drawings"]}, {"text_free_line"})
        self.assertNotEqual(first["drawings"][0]["locator"], first["drawings"][1]["locator"])
        self.assertIn("SYN-001", first["text"])

    def test_preset_line_cannot_hide_substantive_content(self):
        cases = [line('<a:t>SYN patients must apply in 30 days</a:t>'),
                 line('<a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="image1"/>'),
                 line(properties='descr="SYN eligibility terms"'), line(properties='title="SYN condition"'),
                 line('<a:extLst/>'), line(geometry="rect"),
                 line('<wps:txbx><w:txbxContent/></wps:txbx>'),
                 line('<a:prstGeom prst="line"/>'),
                 line().replace('<wp:docPr ', '<wp:docPr unknown="payload" ')]
        for xml in cases:
            with self.subTest(xml=xml):
                self.assertFalse(text_free_line(ET.fromstring(xml)))
                result = extract_bytes(docx('<w:p>' + xml + '</w:p>'), ".docx")[0]
                self.assertEqual(result["status"], "needs_review")

    def test_line_exception_does_not_clear_other_gaps(self):
        for data in [docx('<w:p>' + line() + '</w:p>', footer=True),
                     docx('<w:p>' + line() + '<w:del/></w:p>'),
                     docx('<w:p>' + line() + '<w:pict/></w:p>'),
                     docx(line()),  # Outside a paragraph: unsupported structure.
                     docx('<w:p>' + line() + '<w:drawing/></w:p>')]:
            self.assertEqual(extract_bytes(data, ".docx")[0]["status"], "needs_review")


if __name__ == "__main__":
    unittest.main()
