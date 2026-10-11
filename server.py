"""AirDeck dev server: serves the static site and downloads YouTube audio.

Run:  python3 server.py   (then open http://localhost:8000)
POST /api/youtube  {"url": "https://www.youtube.com/watch?v=..."}
  -> {"file": "downloads/<id>.m4a", "title": "..."}
"url" can also be plain words ("clarity zedd") or a YouTube search link: both
download the top search result.
Requires yt-dlp (pip install -U "yt-dlp[default]" or brew install yt-dlp).
"""

import json
import re
import shutil
import subprocess
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).parent
DOWNLOADS = ROOT / "downloads"
ALLOWED_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"}
PORT = 8000
# The yt-dlp command, or Python's module when pip's per-user install folder isn't on PATH.
YTDLP = ["yt-dlp"] if shutil.which("yt-dlp") else [sys.executable, "-m", "yt_dlp"]
# One video only: watch, shorts and live links, or youtu.be short links.
SINGLE_VIDEO = re.compile(
    r"^https?://((www\.|m\.|music\.)?youtube\.com/(watch\?(\S*&)?v=|shorts/|live/)|youtu\.be/)[\w-]{11}\S*$"
)


def to_target(text):
    """What to hand yt-dlp, or None if it isn't allowed.

    A single video link is used as-is. A YouTube search link or plain words become
    a search for the top result. Playlists, channels and other sites are refused:
    yt-dlp would download every video in them.
    """
    text = text.strip()
    if not text or len(text) > 300:
        return None
    if SINGLE_VIDEO.match(text):
        return text
    if re.match(r"^https?://", text, re.IGNORECASE):
        parsed = urlparse(text)
        if parsed.hostname in ALLOWED_HOSTS and parsed.path == "/results":
            query = parse_qs(parsed.query).get("search_query", [""])[0].strip()
            return f"ytsearch1:{query}" if query else None
        return None
    return f"ytsearch1:{text}"


# yt-dlp needs a JavaScript runtime to see all of YouTube's formats, and only
# looks for Deno by default. Without one, downloads fail with "Requested format
# is not available". Use Node when Deno isn't installed.
JS_RUNTIME = [] if shutil.which("deno") or not shutil.which("node") else ["--js-runtimes", "node"]

# YouTube often answers 403 Forbidden for one download method but not another,
# so try several in order. The first two keep the original audio file (m4a/webm
# decode natively in the browser). The last gets a video file and extracts the
# audio with ffmpeg, so it's only tried when ffmpeg is installed.
AUDIO_ONLY = ["-f", "bestaudio[ext=m4a]/bestaudio"]
STRATEGIES = [
    ("default", AUDIO_ONLY),
    ("alt clients", [*AUDIO_ONLY, "--extractor-args", "youtube:player_client=tv,web_safari,mweb"]),
]
if shutil.which("ffmpeg"):
    STRATEGIES.append(("convert", ["-f", "best", "-x", "--audio-format", "m4a"]))


def download(url, extra):
    """Run yt-dlp once. Returns ((title, path), None) or (None, error message)."""
    cmd = [
        *YTDLP, *JS_RUNTIME, *extra,
        "--no-playlist",
        # Never more than one file, even if the target turns out to be a list.
        "--max-downloads", "1",
        "--max-filesize", "50M",
        "--retries", "3",
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
    # 101 means "stopped at --max-downloads", which is fine.
    if proc.returncode not in (0, 101) or len(lines) < 2:
        return None, (proc.stderr.strip().splitlines() or ["download failed"])[-1]
    return (lines[0], Path(lines[-1])), None


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_POST(self):
        if self.path != "/api/youtube":
            return self.send_json(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length", 0))
            url = json.loads(self.rfile.read(length) or b"{}").get("url", "").strip()
        except (ValueError, json.JSONDecodeError):
            return self.send_json(400, {"error": "invalid request body"})

        target = to_target(url)
        if not target:
            return self.send_json(400, {"error": "paste a single YouTube video link, or type a song name"})
        url = target

        DOWNLOADS.mkdir(exist_ok=True)
        errors = []
        for name, extra in STRATEGIES:
            print(f"[youtube] trying {name}: {url}", flush=True)
            result, err = download(url, extra)
            if result:
                title, filepath = result
                print(f"[youtube] ok via {name}: {title}", flush=True)
                return self.send_json(200, {"file": filepath.relative_to(ROOT).as_posix(), "title": title})
            print(f"[youtube] {name} failed: {err}", flush=True)
            errors.append(err)
        # The first method's error is the real one; later fallbacks fail for their own reasons.
        return self.send_json(502, {"error": errors[0] if errors else "download failed"})

    def send_json(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    print(f"AirDeck running at http://localhost:{PORT} (yt-dlp: {' '.join(YTDLP + JS_RUNTIME)})")
    ThreadingHTTPServer(("", PORT), Handler).serve_forever()
