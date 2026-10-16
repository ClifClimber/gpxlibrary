import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import scan  # noqa: E402

GPX = """<?xml version="1.0"?>
<gpx version="1.1" creator="Test" xmlns="http://www.topografix.com/GPX/1/1">
 <metadata><name>{name}</name></metadata>
 <trk><trkseg>
  <trkpt lat="40.0" lon="-3.0"><ele>1000</ele><time>2024-05-01T08:00:00Z</time></trkpt>
  <trkpt lat="40.01" lon="-3.0"><ele>1100</ele><time>2024-05-01T08:10:00Z</time></trkpt>
  <trkpt lat="40.0" lon="-3.0"><ele>1000</ele><time>2024-05-01T08:20:00Z</time></trkpt>
 </trkseg></trk>
</gpx>"""


class ScanTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root)
        self.index = {"version": scan.INDEX_VERSION, "tracks": {}, "ignored": []}

    def write(self, rel, name):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(GPX.format(name=name), encoding="utf-8")

    def test_first_scan_parses_everything(self):
        self.write("Mtb/a.gpx", "A")
        self.write("notas.txt", "x")
        report = scan.scan(self.root, self.index)
        self.assertEqual(report["new"], ["Mtb/a.gpx"])
        self.assertEqual(self.index["ignored"], ["notas.txt"])
        track = next(iter(self.index["tracks"].values()))
        self.assertEqual(track["km"], 2.2)
        self.assertEqual(track["desnivel_pos_m"], 100)
        self.assertEqual(track["tipo"], "Circular")

    def test_rescan_detects_each_kind_of_change(self):
        self.write("a.gpx", "A")
        self.write("b.gpx", "B")
        self.write("c.gpx", "C")
        scan.scan(self.root, self.index)

        (self.root / "Gravel").mkdir()
        (self.root / "a.gpx").rename(self.root / "Gravel" / "a.gpx")
        self.write("b.gpx", "B2")
        (self.root / "c.gpx").unlink()
        self.write("d.gpx", "D")
        report = scan.scan(self.root, self.index)

        self.assertEqual(report["new"], ["d.gpx"])
        self.assertEqual(report["modified"], ["b.gpx"])
        self.assertEqual(report["removed"], ["c.gpx"])
        self.assertEqual(report["moved"], [{"from": ["a.gpx"], "to": ["Gravel/a.gpx"]}])
        self.assertEqual(report["unchanged"], 0)

    def test_identical_files_share_one_entry(self):
        self.write("x/a.gpx", "A")
        self.write("y/a.gpx", "A")
        report = scan.scan(self.root, self.index)
        self.assertEqual(len(self.index["tracks"]), 1)
        self.assertEqual(report["duplicates"], [["x/a.gpx", "y/a.gpx"]])
        rows = scan.catalog_rows(self.index)
        self.assertEqual([r["duplicado_de"] for r in rows], ["y/a.gpx", "x/a.gpx"])
        self.assertEqual(rows[0]["disciplina"], "Sin clasificar")  # 6,6 km/h: ni MTB ni senderismo


if __name__ == "__main__":
    unittest.main()
