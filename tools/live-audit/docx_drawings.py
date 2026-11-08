"""Narrow structural classification of text-free Word line drawings.

This identifies omitted textual content, not rendered layout or form equivalence.
Unknown shapes, alternate text, relationships and extensions always need review.
"""
import hashlib
import re
import base64
import io
import zipfile
from xml.etree import ElementTree as ET

NS = {
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "wp": "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "wps": "http://schemas.microsoft.com/office/word/2010/wordprocessingShape",
    "wp14": "http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing",
    "v": "urn:schemas-microsoft-com:vml",
    "o": "urn:schemas-microsoft-com:office:office",
    "w14": "http://schemas.microsoft.com/office/word/2010/wordml",
    "w10": "urn:schemas-microsoft-com:office:word",
}


def tag(name):
    prefix, local = name.split(":")
    return f"{{{NS[prefix]}}}{local}"


# Exact supported vocabulary. A line preset alone is insufficient: shapes can also
# carry text, images, alternate text, external relationships or extension payloads.
ATTRIBUTES = {
    "w:drawing": set(),
    "wp:anchor": {"distT", "distB", "distL", "distR", "simplePos", "relativeHeight", "behindDoc", "locked", "layoutInCell", "allowOverlap", tag("wp14:anchorId"), tag("wp14:editId")},
    "wp:simplePos": {"x", "y"}, "wp:positionH": {"relativeFrom"}, "wp:positionV": {"relativeFrom"},
    "wp:posOffset": set(), "wp:extent": {"cx", "cy"}, "wp:effectExtent": {"l", "t", "r", "b"},
    "wp:wrapNone": set(), "wp:docPr": {"id", "name"}, "wp:cNvGraphicFramePr": set(),
    "a:graphic": set(), "a:graphicData": {"uri"}, "wps:wsp": set(), "wps:cNvCnPr": set(),
    "wps:spPr": set(), "a:xfrm": {"flipV", "flipH"}, "a:off": {"x", "y"}, "a:ext": {"cx", "cy"},
    "a:prstGeom": {"prst"}, "a:avLst": set(), "wps:style": set(), "a:lnRef": {"idx"},
    "a:schemeClr": {"val"}, "a:fillRef": {"idx"}, "a:effectRef": {"idx"}, "a:fontRef": {"idx"},
    "wps:bodyPr": set(), "wp14:sizeRelH": {"relativeFrom"}, "wp14:sizeRelV": {"relativeFrom"},
    "wp14:pctWidth": set(), "wp14:pctHeight": set(),
}
ALLOWED = {tag(name): attrs for name, attrs in ATTRIBUTES.items()}
NUMERIC_TEXT = {tag(name) for name in ("wp:posOffset", "wp14:pctWidth", "wp14:pctHeight")}


def text_free_line(drawing):
    for element in drawing.iter():
        if element.tag not in ALLOWED or set(element.attrib) - ALLOWED[element.tag]:
            return False
        if element.text and element.text.strip():
            if element.tag not in NUMERIC_TEXT or not re.fullmatch(r"-?\d+", element.text.strip()):
                return False
        if element.tail and element.tail.strip():
            return False
    if len(drawing) != 1 or drawing[0].tag != tag("wp:anchor"):
        return False
    shapes = drawing.findall(".//wps:wsp", NS)
    geometry = drawing.findall(".//a:prstGeom", NS)
    graphic = drawing.findall(".//a:graphicData", NS)
    return (len(shapes) == len(geometry) == len(graphic) == 1
            and geometry[0].get("prst") == "line"
            and graphic[0].get("uri") == NS["wps"]
            and len(drawing.findall(".//wp:docPr", NS)) == 1)


def line_metadata(encoded):
    """Validate the bounded legacy round-trip package rather than ignore its payload."""
    if len(encoded) > 100_000:
        return False
    try:
        with zipfile.ZipFile(io.BytesIO(base64.b64decode(re.sub(r"\s", "", encoded), validate=True))) as archive:
            expected = {"[Content_Types].xml", "_rels/.rels", "drs/e2oDoc.xml", "drs/downrev.xml"}
            if set(archive.namelist()) != expected or len(archive.infolist()) != 4 or sum(m.file_size for m in archive.infolist()) > 1_000_000:
                return False
            trees = {}
            for name in expected:
                xml = archive.read(name)
                if b"<!DOCTYPE" in xml.upper() or b"<!ENTITY" in xml.upper():
                    return False
                trees[name] = ET.fromstring(xml)
        tree = trees["drs/e2oDoc.xml"]
        allowed = dict(ALLOWED)
        allowed.update({tag("wp:e2oholder"): set(), tag("wp:effectOffset"): {"l", "t", "r", "b"}, tag("wps:cNvPr"): {"id", "name"}})
        if tree.tag != tag("wp:e2oholder"):
            return False
        for e in tree.iter():
            if e.tag not in allowed or set(e.attrib) - allowed[e.tag] or (e.text or "").strip() or (e.tail or "").strip():
                return False
        geometry = tree.findall(".//a:prstGeom", NS)
        if len(geometry) != 1 or geometry[0].get("prst") != "line" or len(tree.findall(".//wps:wsp", NS)) != 1:
            return False
        downrev = trees["drs/downrev.xml"]
        if downrev.tag != tag("a:downRevStg") or downrev.get("textCheckSum", "") != "":
            return False
        down_allowed = {tag("a:downRevStg"): {"shapeCheckSum", "textCheckSum", "ver"}, tag("a:bounds"): {"l", "t", "r", "b"}}
        if any(e.tag not in down_allowed or set(e.attrib) - down_allowed[e.tag] or (e.text or "").strip() for e in downrev.iter()):
            return False
        # Package references must remain internal to the known line metadata.
        for e in trees["_rels/.rels"]:
            if e.get("TargetMode") == "External" or e.get("Target", "").lstrip("/") not in {"drs/e2oDoc.xml", "drs/downrev.xml"}:
                return False
        return True
    except (ValueError, zipfile.BadZipFile, KeyError, ET.ParseError):
        return False


STYLE_KEYS = {"position", "left", "top", "text-align", "margin-left", "margin-top", "width", "height", "z-index", "flip", "visibility", "mso-wrap-style", "mso-wrap-distance-left", "mso-wrap-distance-right", "mso-wrap-distance-top", "mso-wrap-distance-bottom", "mso-position-horizontal", "mso-position-horizontal-relative", "mso-position-vertical", "mso-position-vertical-relative", "mso-width-percent", "mso-height-percent", "mso-width-relative", "mso-height-relative"}
VML_ATTRIBUTES = {
    tag("w:pict"): {tag("w14:anchorId")},
    tag("v:line"): {tag("w14:anchorId"), "id", tag("o:spid"), "style", "from", "to", tag("o:gfxdata"), "strokecolor"},
    tag("v:group"): {"id", "style", "coordorigin", "coordsize"},
    tag("v:shape"): {"id", "style", "coordorigin", "coordsize", "path", "filled", "strokeweight"},
    tag("v:path"): {"arrowok"}, tag("w10:wrap"): {"anchorx"},
}


def text_free_legacy_lines(picture):
    lines = 0
    for e in picture.iter():
        if e.tag not in VML_ATTRIBUTES or set(e.attrib) - VML_ATTRIBUTES[e.tag] or (e.text or "").strip() or (e.tail or "").strip():
            return False
        for declaration in e.get("style", "").split(";"):
            if not declaration:
                continue
            key, separator, value = declaration.partition(":")
            if not separator or key not in STYLE_KEYS or not re.fullmatch(r"-?(?:\d+(?:\.\d+)?|\.\d+)(?:pt|mm)?|absolute|left|visible|square|text|margin|page|x|y", value):
                return False
        if e.tag == tag("v:line"):
            lines += 1
            if len(e) or not all(re.fullmatch(r"-?(?:\d+(?:\.\d+)?|\.\d+)pt,-?(?:\d+(?:\.\d+)?|\.\d+)pt", e.get(k, "")) for k in ("from", "to")):
                return False
            if tag("o:gfxdata") in e.attrib and not line_metadata(e.get(tag("o:gfxdata"))):
                return False
        if e.tag == tag("v:shape"):
            lines += 1
            path = re.fullmatch(r"m-?\d+,-?\d+r(-?\d*),(-?\d*)e", e.get("path", ""))
            if not path or e.get("filled") != "f" or not (path[1] in {"", "0"} or path[2] in {"", "0"}):
                return False
    return lines > 0


def inventory(body):
    result = []
    for paragraph_number, paragraph in enumerate(body.iter(tag("w:p")), 1):
        for drawing in [e for e in paragraph.iter() if e.tag in {tag("w:drawing"), tag("w:pict")}]:
            legacy = drawing.tag == tag("w:pict")
            line = text_free_legacy_lines(drawing) if legacy else text_free_line(drawing)
            properties = drawing.find(".//wp:docPr", NS)
            result.append(dict(
                locator=f"word/document.xml drawing {len(result) + 1} (paragraph {paragraph_number})",
                xml_sha256=hashlib.sha256(ET.tostring(drawing, encoding="utf-8")).hexdigest(),
                hash_basis="ElementTree serialization of the drawing element, bound to the original snapshot hash",
                name=properties.get("name") if properties is not None else "Legacy line/border group",
                classification=("text_free_legacy_lines" if legacy else "text_free_line") if line else "requires_visual_review",
                explanation=("Legacy line/border group and any round-trip payload contain only supported text-free line structures. Rendered layout is unverified." if legacy else "Single preset line; supported structural vocabulary contains no text, image, alternate text or relationship. Rendered layout is unverified.")
                            if line else "Drawing is outside the narrow text-free line profile; content needs visual review."))
    return result
