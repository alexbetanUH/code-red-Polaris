"""AirDeck dev server: serves the static site, downloads YouTube audio, and runs the AI DJ.

Run:  python3 server.py   (then open http://localhost:8000)
POST /api/youtube  {"url": "https://www.youtube.com/watch?v=..."}
  -> {"file": "downloads/<id>.m4a", "title": "..."}
"url" can also be plain words ("clarity zedd") or a YouTube search link: both
download the top search result.
POST /api/dj/pick  {"vibe": "...", "nowPlaying": "...", "queued": [...], "played": [...], "count": 3}
  -> {"picks": [{"artist", "title", "reason", "intro"}]}   (Gemini; needs GEMINI_API_KEY)
POST /api/dj/voice {"text": "..."}
  -> {"file": "downloads/voice/<hash>.mp3"}   (ElevenLabs; needs ELEVENLABS_API_KEY)
Requires yt-dlp (pip install -U "yt-dlp[default]" or brew install yt-dlp).
API keys are read from environment variables and never sent to the browser.
"""

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).parent
DOWNLOADS = ROOT / "downloads"
VOICES = DOWNLOADS / "voice"
# Searches and links already downloaded, so asking again (e.g. in a rehearsed demo) skips yt-dlp.
DOWNLOAD_INDEX = DOWNLOADS / "index.json"
index_lock = threading.Lock()
ALLOWED_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"}
PORT = 8000
# The yt-dlp command, or Python's module when pip's per-user install folder isn't on PATH.
YTDLP = ["yt-dlp"] if shutil.which("yt-dlp") else [sys.executable, "-m", "yt_dlp"]
# One video only: watch, shorts and live links, or youtu.be short links.
SINGLE_VIDEO = re.compile(
    r"^https?://((www\.|m\.|music\.)?youtube\.com/(watch\?(\S*&)?v=|shorts/|live/)|youtu\.be/)[\w-]{11}\S*$"
)

# AI DJ settings (environment variables override the defaults).
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.8-flash")
ELEVENLABS_VOICE = os.environ.get("ELEVENLABS_VOICE_ID", "JBFqnCBsd6RMkjVDRZzb")
ELEVENLABS_MODEL = "eleven_flash_v2_5"  # ElevenLabs' low-latency voice model


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


def load_index():
    try:
        return json.loads(DOWNLOAD_INDEX.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def remembered(target):
    """The earlier download for this search or link, if its file is still there."""
    entry = load_index().get(target.lower())
    return entry if entry and (ROOT / entry["file"]).exists() else None


def remember(target, entry):
    with index_lock:
        index = load_index()
        index[target.lower()] = entry
        DOWNLOAD_INDEX.write_text(json.dumps(index, indent=1), encoding="utf-8")


# ---- AI DJ -------------------------------------------------------------------------

class DjError(Exception):
    """A DJ request failed in a way worth showing to the user."""


DJ_INSTRUCTIONS = """You are the AI DJ in AirDeck, a hand-gesture DJ app, picking the next songs for a live set.
Pick real, well-known songs that are easy to find on YouTube, matching the requested vibe and flowing
naturally from what's playing now (similar energy, tempo and genre, or a smooth step toward the vibe).
Never pick a song that's already queued or played. Vary the artists.
For each pick give:
- reason: why it fits, under 12 words.
- intro: what you'd say on the mic right before it plays, like a radio DJ. One or two short, upbeat
  sentences that name the song and artist. No emojis, hashtags or stage directions."""

PICK_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "picks": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "artist": {"type": "STRING"},
                    "title": {"type": "STRING"},
                    "reason": {"type": "STRING"},
                    "intro": {"type": "STRING"},
                },
                "required": ["artist", "title", "reason", "intro"],
            },
        }
    },
    "required": ["picks"],
}


def post_json(url, body, headers, timeout=60):
    """POST JSON and return the raw response bytes. Raises DjError with the API's own message."""
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", **headers},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read()
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")
        try:
            parsed = json.loads(detail)
            detail = parsed.get("error", {}).get("message") or parsed.get("detail", {}).get("message") or detail
        except (ValueError, AttributeError):
            pass
        raise DjError(f"{error.code}: {str(detail)[:200]}") from None
    except (urllib.error.URLError, TimeoutError) as error:
        raise DjError(f"couldn't reach the service ({error})") from None


def clean(text, limit):
    return " ".join(str(text).split())[:limit]


def dj_pick(request):
    """Ask Gemini for the next songs. Returns a list of {artist, title, reason, intro}."""
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        raise DjError("set GEMINI_API_KEY before starting server.py to use the AI DJ")
    count = max(1, min(int(request.get("count") or 3), 5))
    listing = lambda name: "\n".join(f"- {clean(t, 120)}" for t in request.get(name, [])[-25:]) or "(none)"
    prompt = (
        f"Vibe: {clean(request.get('vibe') or 'keep the current energy going', 200)}\n"
        f"Now playing: {clean(request.get('nowPlaying') or 'nothing yet', 120)}\n"
        f"Already queued:\n{listing('queued')}\n"
        f"Already played:\n{listing('played')}\n"
        f"Pick {count} songs."
    )
    body = {
        "systemInstruction": {"parts": [{"text": DJ_INSTRUCTIONS}]},
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"responseMimeType": "application/json", "responseSchema": PICK_SCHEMA},
    }
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
    data = json.loads(post_json(url, body, {"x-goog-api-key": key}))
    try:
        parts = data["candidates"][0]["content"]["parts"]
        text = "".join(part.get("text", "") for part in parts)
        picks = json.loads(text)["picks"]
    except (KeyError, IndexError, ValueError, TypeError):
        raise DjError("Gemini returned an unexpected answer") from None
    cleaned = []
    for pick in picks[:count]:
        artist, title = clean(pick.get("artist", ""), 80), clean(pick.get("title", ""), 120)
        if artist and title:
            cleaned.append({
                "artist": artist,
                "title": title,
                "reason": clean(pick.get("reason", ""), 160),
                "intro": clean(pick.get("intro", ""), 300),
            })
    if not cleaned:
        raise DjError("Gemini didn't pick any songs")
    return cleaned


def dj_voice(text):
    """Speak a DJ line with ElevenLabs. Returns the MP3's path, cached by voice and text."""
    key = os.environ.get("ELEVENLABS_API_KEY")
    if not key:
        raise DjError("set ELEVENLABS_API_KEY to use the ElevenLabs voice")
    text = clean(text, 300)
    if not text:
        raise DjError("nothing to say")
    VOICES.mkdir(parents=True, exist_ok=True)
    path = VOICES / f"{hashlib.sha1(f'{ELEVENLABS_VOICE}|{text}'.encode()).hexdigest()[:16]}.mp3"
    if not path.exists():
        url = f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_VOICE}?output_format=mp3_44100_128"
        audio = post_json(url, {"text": text, "model_id": ELEVENLABS_MODEL}, {"xi-api-key": key})
        path.write_bytes(audio)
    return path


# ---- HTTP --------------------------------------------------------------------------

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_POST(self):
        routes = {"/api/youtube": self.youtube, "/api/dj/pick": self.pick, "/api/dj/voice": self.voice}
        route = routes.get(self.path)
        if not route:
            return self.send_json(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length) or b"{}")
            if not isinstance(body, dict):
                raise ValueError
        except (ValueError, json.JSONDecodeError):
            return self.send_json(400, {"error": "invalid request body"})
        route(body)

    def youtube(self, body):
        target = to_target(str(body.get("url", "")))
        if not target:
            return self.send_json(400, {"error": "paste a single YouTube video link, or type a song name"})

        hit = remembered(target)
        if hit:
            print(f"[youtube] already downloaded: {hit['title']}", flush=True)
            return self.send_json(200, hit)

        DOWNLOADS.mkdir(exist_ok=True)
        errors = []
        for name, extra in STRATEGIES:
            print(f"[youtube] trying {name}: {target}", flush=True)
            result, err = download(target, extra)
            if result:
                title, filepath = result
                print(f"[youtube] ok via {name}: {title}", flush=True)
                entry = {"file": filepath.relative_to(ROOT).as_posix(), "title": title}
                remember(target, entry)
                return self.send_json(200, entry)
            print(f"[youtube] {name} failed: {err}", flush=True)
            errors.append(err)
        # The first method's error is the real one; later fallbacks fail for their own reasons.
        return self.send_json(502, {"error": errors[0] if errors else "download failed"})

    def pick(self, body):
        try:
            picks = dj_pick(body)
        except DjError as error:
            print(f"[dj] pick failed: {error}", flush=True)
            return self.send_json(502, {"error": str(error)})
        print(f"[dj] picked: {'; '.join(p['artist'] + ' - ' + p['title'] for p in picks)}", flush=True)
        self.send_json(200, {"picks": picks})

    def voice(self, body):
        try:
            path = dj_voice(str(body.get("text", "")))
        except DjError as error:
            print(f"[dj] voice failed: {error}", flush=True)
            return self.send_json(502, {"error": str(error)})
        self.send_json(200, {"file": path.relative_to(ROOT).as_posix()})

    def send_json(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    print(f"AirDeck running at http://localhost:{PORT} (yt-dlp: {' '.join(YTDLP + JS_RUNTIME)})")
    gemini = f"on ({GEMINI_MODEL})" if os.environ.get("GEMINI_API_KEY") else "off (set GEMINI_API_KEY)"
    voice = "ElevenLabs" if os.environ.get("ELEVENLABS_API_KEY") else "browser voice (set ELEVENLABS_API_KEY for ElevenLabs)"
    print(f"AI DJ: {gemini}, voice: {voice}")
    ThreadingHTTPServer(("", PORT), Handler).serve_forever()
