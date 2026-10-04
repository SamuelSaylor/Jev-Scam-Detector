# pyright: basic
"""Download the free Vosk English model into cross-tab-demo/models (about 40 MB)."""

import io
import urllib.request
import zipfile
from pathlib import Path

URL = "https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip"
DEST = Path(__file__).parent / "models"

if __name__ == "__main__":
    DEST.mkdir(exist_ok=True)
    with urllib.request.urlopen(URL) as response:
        zipfile.ZipFile(io.BytesIO(response.read())).extractall(DEST)
    print(f"Model ready in {DEST}")
