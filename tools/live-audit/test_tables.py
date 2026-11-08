"""Regression cases for scoped FPL cell verification without network requests."""
import io
import unittest
import zipfile
from xml.etree import ElementTree as ET

from server import W, approved, fpl_row


def document(rows: list[list[str]]) -> bytes:
    """Construct a minimal Word main part with a single test table."""
    prefix = "{" + W["w"] + "}"
    root = ET.Element(prefix + "document")
    table = ET.SubElement(root, prefix + "tbl")
    for cells in rows:
        row = ET.SubElement(table, prefix + "tr")
        for value in cells:
            cell = ET.SubElement(row, prefix + "tc")
            ET.SubElement(cell, prefix + "t").text = value
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as archive:
        archive.writestr("word/document.xml", ET.tostring(root))
    return out.getvalue()


class TableTests(unittest.TestCase):
    """Check that year, units, household size and column scope matter."""

    def setUp(self) -> None:
        """Use a reordered 400% column to guard against hard-coded positions."""
        self.rows = [["2026 Federal Poverty Levels"], ["Household Size", "400%", "200%"],
                     ["2 Persons", "$86,560", "$43,280"], ["1 Person", "$63,840", "$31,920"]]

    def test_matches_header_and_household(self) -> None:
        """The value must come from the 400% column on the one-person row."""
        self.assertEqual(fpl_row(document(self.rows))["amount"], 63840)

    def test_conflicting_rows(self) -> None:
        """Multiple candidate rows require review."""
        self.assertIsNone(fpl_row(document(self.rows + [["1 Person", "$62,600", "$31,300"]])))

    def test_monthly_table(self) -> None:
        """A monthly table cannot establish the annual amount."""
        self.assertIsNone(fpl_row(document([["Monthly amounts"]] + self.rows)))

    def test_external_link(self) -> None:
        """The MCP server cannot fetch arbitrary agent-supplied domains."""
        with self.assertRaises(ValueError):
            approved("https://www.bassett.org.example.com/file.docx")


if __name__ == "__main__":
    unittest.main()
