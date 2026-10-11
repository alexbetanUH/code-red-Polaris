"""Run: python3 tests/server-static.py. Private files stay inaccessible over HTTP."""
import importlib.util
from pathlib import Path
import tempfile
import threading
import urllib.request
import urllib.error

spec = importlib.util.spec_from_file_location("airdeck_server", Path(__file__).resolve().parents[1] / "server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)

with tempfile.TemporaryDirectory() as temporary:
    server.ROOT = Path(temporary)
    (server.ROOT / ".env").write_text("TEST_SETTING=private-fixture")
    (server.ROOT / ".git").mkdir()
    (server.ROOT / ".git" / "config").write_text("private-fixture")
    (server.ROOT / "landing.html").write_text("public-home")
    (server.ROOT / "asset.js").write_text("public-asset")
    (server.ROOT / "assets").mkdir()
    handler = type("QuietHandler", (server.Handler,), {"log_message": lambda *args: None})
    http = server.Server(("127.0.0.1", 0), handler)
    worker = threading.Thread(target=http.serve_forever, daemon=True)
    worker.start()
    base = f"http://127.0.0.1:{http.server_port}"
    try:
        for method in ("GET", "HEAD"):
            for path in ("/.env", "/%2eenv", "/.env?cache=1", "/.git/config", "/%2egit/config", "/assets/"):
                try:
                    urllib.request.urlopen(urllib.request.Request(base + path, method=method)).close()
                    raise AssertionError(f"{method} {path} should be blocked")
                except urllib.error.HTTPError as error:
                    assert error.code == 404, (path, error.code)
            for path in ("/", "/asset.js"):
                with urllib.request.urlopen(urllib.request.Request(base + path, method=method)) as response:
                    assert response.status == 200
        print("PASS: GET/HEAD hide configuration, Git metadata and directory listings; public assets still serve")
    finally:
        http.shutdown()
        http.server_close()
        worker.join()
