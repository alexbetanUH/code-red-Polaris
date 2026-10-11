"""AirDeck dev server: serves the static site and downloads YouTube audio.

Run:  python3 server.py   (then open http://localhost:8000)
POST /api/youtube  {"url": "https://www.youtube.com/watch?v=..."}
  -> {"file": "downloads/<id>.m4a", "title": "..."}
Requires yt-dlp on PATH (brew install yt-dlp).
"""

import json
import os
import subprocess
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).parent
DOWNLOADS = ROOT / "downloads"
ALLOWED_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"}
PORT = 8000
# Only this computer can reach the server unless you opt in (e.g. AIRDECK_HOST=0.0.0.0 to demo over Wi-Fi).
HOST = os.environ.get("AIRDECK_HOST", "127.0.0.1")
MAX_BODY = 4096
downloads_slots = threading.Semaphore(2)   # at most 2 yt-dlp runs at once


# YouTube often answers 403 Forbidden for one download method but not another,
# so try several in order. The first keeps the original audio file (m4a/webm
# decode natively in the browser); the fallbacks may get a video file, so they
# extract the audio to m4a with ffmpeg.
TO_M4A = ["-x", "--audio-format", "m4a"]
STRATEGIES = [
    ("default", ["-f", "bestaudio[ext=m4a]/bestaudio"]),
    ("alt clients", ["-f", "bestaudio/best", *TO_M4A,
                     "--extractor-args", "youtube:player_client=tv,web_safari,mweb"]),
    ("convert", ["-f", "best", *TO_M4A]),
]


def download(url, extra):
    """Run yt-dlp once. Returns ((title, path), None) or (None, error message)."""
    cmd = [
        "yt-dlp", *extra,
        "--no-playlist",
        "--max-filesize", "50M",
        "--retries", "3",
        "--socket-timeout", "15",
        "-o", str(DOWNLOADS / "%(id)s.%(ext)s"),
        "--no-simulate",
        "--print", "title",
        "--print", "after_move:filepath",
        "--", url,
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    except subprocess.TimeoutExpired:
        return None, "download timed out"
    lines = [l for l in proc.stdout.splitlines() if l.strip()]
    if proc.returncode != 0 or len(lines) < 2:
        return None, (proc.stderr.strip().splitlines() or ["download failed"])[-1]
    return (lines[0], Path(lines[-1])), None


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        # Always revalidate files, so edits show up on a normal reload (no stale cached scripts)
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_POST(self):
        if self.path != "/api/youtube":
            return self.send_json(404, {"error": "not found"})
        # Only our own page may call this (blocks drive-by requests from other websites)
        origin = self.headers.get("Origin")
        if origin and urlparse(origin).netloc != self.headers.get("Host"):
            return self.send_json(403, {"error": "forbidden origin"})
        if "application/json" not in self.headers.get("Content-Type", ""):
            return self.send_json(415, {"error": "expected application/json"})
        try:
            length = int(self.headers.get("Content-Length", 0))
            if not 0 <= length <= MAX_BODY:
                raise ValueError("bad length")
            data = json.loads(self.rfile.read(length) or b"{}")
            url = data["url"].strip() if isinstance(data, dict) and isinstance(data.get("url"), str) else ""
        except (ValueError, json.JSONDecodeError):
            return self.send_json(400, {"error": "invalid request body"})

        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https") or parsed.hostname not in ALLOWED_HOSTS:
            return self.send_json(400, {"error": "please paste a youtube.com or youtu.be link"})

        if not downloads_slots.acquire(blocking=False):
            return self.send_json(429, {"error": "busy downloading, try again in a moment"})
        try:
            return self.download_youtube(url)
        finally:
            downloads_slots.release()

    def download_youtube(self, url):
        DOWNLOADS.mkdir(exist_ok=True)
        err = "download failed"
        for name, extra in STRATEGIES:
            print(f"[youtube] trying {name}: {url}", flush=True)
            result, err = download(url, extra)
            if result:
                title, filepath = result
                print(f"[youtube] ok via {name}: {title}", flush=True)
                return self.send_json(200, {"file": filepath.relative_to(ROOT).as_posix(), "title": title})
            print(f"[youtube] {name} failed: {err}", flush=True)
        return self.send_json(502, {"error": err})

    def send_json(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    print(f"AirDeck running at http://localhost:{PORT}  (listening on {HOST})")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
