"""Launch the MCP server using the project's virtual environment on any platform."""
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[2]
python = ROOT / ".venv" / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
if not python.is_file():
    sys.exit("Create .venv and install tools/live-audit/requirements.txt; see README.md.")

if __name__ == "__main__":
    sys.exit(subprocess.call([str(python), str(Path(__file__).with_name("server.py"))], cwd=ROOT))
