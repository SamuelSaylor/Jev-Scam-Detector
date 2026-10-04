from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from jev_scam_detector.app import configured_origin, install_static


def test_origin_precedence_and_validation() -> None:
    assert configured_origin({}) == "http://127.0.0.1:5173"
    assert (
        configured_origin({"RENDER_EXTERNAL_URL": "https://demo.onrender.com"})
        == "https://demo.onrender.com"
    )
    assert (
        configured_origin(
            {
                "FRONTEND_ORIGIN": "https://call.example.org",
                "RENDER_EXTERNAL_URL": "https://demo.onrender.com",
            }
        )
        == "https://call.example.org"
    )
    for value in (
        "",
        "https://demo.onrender.com/",
        "https://demo.onrender.com/path",
        "https://user@demo.onrender.com",
        "https://demo.onrender.com?x=1",
        "https://demo.onrender.com#x",
        "javascript:alert(1)",
        "https://demo.onrender.com:bad",
    ):
        with pytest.raises(ValueError):
            _ = configured_origin({"FRONTEND_ORIGIN": value})


def test_packaged_static_routes(tmp_path: Path) -> None:
    (tmp_path / "assets").mkdir()
    _ = (tmp_path / "index.html").write_text("<html>Jev call</html>")
    _ = (tmp_path / "config.json").write_text('{"iceServers":[]}')
    _ = (tmp_path / "assets" / "demo.js").write_bytes(b"console.log('jev')")
    site = FastAPI()

    @site.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    install_static(site, tmp_path)
    with TestClient(site) as client:
        assert client.get("/").text == "<html>Jev call</html>"
        assert client.get("/room/example").text == "<html>Jev call</html>"
        assert client.head("/room/example").status_code == 200
        assert client.get("/assets/demo.js").content == b"console.log('jev')"
        assert client.get("/assets/missing.js").status_code == 404
        assert client.get("/missing.js").status_code == 404
        assert client.get("/config.json").headers["cache-control"] == "no-store"
        assert client.get("/config.json").json() == {"iceServers": []}
        assert client.get("/api/health").json() == {"status": "ok"}
        missing = client.get("/api/missing")
        assert missing.status_code == 404
        assert "<html>Jev call</html>" not in missing.text


def test_missing_build_fails(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="JEV_STATIC_ROOT"):
        install_static(FastAPI(), tmp_path)
