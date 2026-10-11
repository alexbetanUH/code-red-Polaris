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
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000  # python server.py 8001 for another port
# Only this computer can reach the server (and spend the API keys' credits) unless you
# opt in, e.g. AIRDECK_HOST=0.0.0.0 to open it to your Wi-Fi.
HOST = os.environ.get("AIRDECK_HOST", "127.0.0.1")
AI_TIMEOUT = 15  # seconds before a Gemini or ElevenLabs request gives up (songs are short)
# The yt-dlp command, or Python's module when pip's per-user install folder isn't on PATH.
YTDLP = ["yt-dlp"] if shutil.which("yt-dlp") else [sys.executable, "-m", "yt_dlp"]
# One video only: watch, shorts and live links, or youtu.be short links.
SINGLE_VIDEO = re.compile(
    r"^https?://((www\.|m\.|music\.)?youtube\.com/(watch\?(\S*&)?v=|shorts/|live/)|youtu\.be/)[\w-]{11}\S*$"
)

# AI DJ settings (environment variables override the defaults).
# Flash-Lite: the free tier allows 500 requests a day (3.8 Flash only 20), plenty for picking songs.
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash-lite")
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
# so try several in order. The first three keep the original audio file (m4a/webm
# decode natively in the browser), or at worst a small mp4. The last gets a video file and extracts the
# audio with ffmpeg, so it's only tried when ffmpeg is installed.
AUDIO_ONLY = ["-f", "bestaudio[ext=m4a]/bestaudio"]
STRATEGIES = [
    ("default", AUDIO_ONLY),
    ("alt clients", [*AUDIO_ONLY, "--extractor-args", "youtube:player_client=tv,web_safari,mweb"]),
    # Some music videos 403 on every client above. These clients often still work, and
    # "best" (a small mp4 with audio) is a last resort the browser can still decode.
    ("more clients", ["-f", "bestaudio/best", "--extractor-args", "youtube:player_client=android_vr,web_embedded,ios"]),
]
if shutil.which("ffmpeg"):
    STRATEGIES.append(("convert", ["-f", "best", "-x", "--audio-format", "m4a"]))


# Download progress the page polls (GET /api/progress?job=...), keyed by a job id it sends.
progress = {}  # job -> {"stage": "searching" | "downloading", "percent": number or None}
progress_lock = threading.Lock()
PROGRESS_MARK = "AIRDECK-PROGRESS"


def set_progress(job, **values):
    if job:
        with progress_lock:
            progress[job] = {**progress.get(job, {}), **values}


def download(url, extra, job=None):
    """Run yt-dlp once, reporting progress for job. Returns ((title, path), None) or (None, error message)."""
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
        # One machine-readable progress line per update (shown even though --print makes it quiet).
        "--progress", "--newline",
        "--progress-template",
        f"download:{PROGRESS_MARK} %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s",
        "--", url,
    ]
    # UTF-8 so titles with accents or emoji come through intact on Windows.
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", env=env
    )
    timed_out = threading.Event()

    def stop():
        timed_out.set()
        proc.kill()

    timer = threading.Timer(180, stop)
    timer.start()
    printed, errors = [], []
    try:
        for line in proc.stdout:
            line = line.strip()
            if line.startswith(PROGRESS_MARK):
                numbers = []
                for value in line.split()[1:4]:
                    try:
                        numbers.append(float(value))
                    except ValueError:  # "NA" when yt-dlp doesn't know yet
                        numbers.append(None)
                done, total, estimate = (numbers + [None, None, None])[:3]
                if done is not None and (total or estimate):
                    set_progress(job, stage="downloading", percent=min(100.0, done * 100 / (total or estimate)))
            elif line.startswith("ERROR:"):
                errors.append(line)
            elif line and not line.startswith(("WARNING:", "[")):
                printed.append(line)  # what --print asked for: the title, then the file path
        proc.wait()
    finally:
        timer.cancel()
    if timed_out.is_set():
        return None, "download timed out"
    # 101 means "stopped at --max-downloads", which is fine.
    if proc.returncode not in (0, 101) or len(printed) < 2:
        return None, (errors or ["download failed"])[-1]
    return (printed[0], Path(printed[-1])), None


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


def get_song(target, job=None):
    """The song's {"file", "title"}, downloading it unless it was downloaded before.
    Returns (entry, None) or (None, error message)."""
    hit = remembered(target)
    if hit:
        print(f"[youtube] already downloaded: {hit['title']}", flush=True)
        return hit, None

    DOWNLOADS.mkdir(exist_ok=True)
    errors = []
    for name, extra in STRATEGIES:
        print(f"[youtube] trying {name}: {target}", flush=True)
        result, err = download(target, extra, job)
        if result:
            title, filepath = result
            print(f"[youtube] ok via {name}: {title}", flush=True)
            entry = {"file": filepath.relative_to(ROOT).as_posix(), "title": title}
            remember(target, entry)
            return entry, None
        print(f"[youtube] {name} failed: {err}", flush=True)
        errors.append(err)
    # The first method's error is the real one; later fallbacks fail for their own reasons.
    return None, errors[0] if errors else "download failed"


# ---- AI DJ -------------------------------------------------------------------------

class DjError(Exception):
    """A DJ request failed in a way worth showing to the user."""


DJ_INSTRUCTIONS = """You are the AI DJ in AirDeck, a hand-gesture DJ app, picking the next songs for a live set.
Pick real, well-known songs that are easy to find on YouTube, matching the requested vibe and flowing
naturally from what's playing now (similar energy, tempo and genre, or a smooth step toward the vibe).
Never pick a song that's already queued or played. Vary the artists.
For each pick give:
- reason: why it fits, under 12 words.
- intro: what you'd say on the mic as it comes in, like a radio DJ. You only get on the mic when the
  set switches genre (and at the very start), so make it about the switch: one or two short, upbeat
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


LIBRARY_PICK_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "picks": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "id": {"type": "STRING"},
                    "reason": {"type": "STRING"},
                    "intro": {"type": "STRING"},
                },
                "required": ["id", "reason", "intro"],
            },
        }
    },
    "required": ["picks"],
}


def ask_gemini_for_picks(prompt, schema):
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        raise DjError("set GEMINI_API_KEY before starting server.py to use the AI DJ")
    body = {
        "systemInstruction": {"parts": [{"text": DJ_INSTRUCTIONS}]},
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"responseMimeType": "application/json", "responseSchema": schema},
    }
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
    data = json.loads(post_json(url, body, {"x-goog-api-key": key}, timeout=AI_TIMEOUT))
    try:
        parts = data["candidates"][0]["content"]["parts"]
        return json.loads("".join(part.get("text", "") for part in parts))["picks"]
    except (KeyError, IndexError, ValueError, TypeError):
        raise DjError("Gemini returned an unexpected answer") from None


def bpm(song):
    """A library song's BPM as a whole number, or None."""
    try:
        return round(float(song.get("bpm"))) if song and song.get("bpm") else None
    except (TypeError, ValueError):
        return None


def tempo_gap(a, b):
    """How far apart two tempos are, counting half and double time as close (80 ~ 160)."""
    if not a or not b:
        return 0
    return min(abs(a - b), abs(a - 2 * b), abs(2 * a - b))


def dj_pick(request):
    """Ask Gemini for the next songs. Returns (picks, offline): picks is a list of
    {artist, title, reason, intro}; offline is why Gemini couldn't be used, or None.

    With a "library" ([{id, artist, title, bpm, genre}]) in the request, Gemini may only pick
    from it and each pick also has its "id". If Gemini fails (no key, no internet, rate
    limit, overload), the closest library songs are picked instead, so the music keeps
    going. Without a library Gemini can pick any song (beta), and has to work.
    """
    offline = None
    count = max(1, min(int(request.get("count") or 3), 5))
    listing = lambda name: "\n".join(f"- {clean(t, 120)}" for t in request.get(name, [])[-25:]) or "(none)"
    situation = (
        f"Vibe: {clean(request.get('vibe') or 'keep the current energy going', 200)}\n"
        f"Now playing: {clean(request.get('nowPlaying') or 'nothing yet', 120)}\n"
        f"Already queued:\n{listing('queued')}\n"
        f"Already played:\n{listing('played')}\n"
    )

    library = {
        clean(song.get("id", ""), 20): song
        for song in request.get("library") or []
        if isinstance(song, dict) and song.get("id")
    }
    if library:
        def facts(s):
            known = [f"~{bpm(s)} BPM" if bpm(s) else "", clean(s.get("genre", ""), 40)]
            return f" ({', '.join(k for k in known if k)})" if any(known) else ""

        menu = "\n".join(
            f"- {song_id}: {clean(s.get('artist', ''), 80)} - {clean(s.get('title', ''), 120)}{facts(s)}"
            for song_id, s in library.items()
        )
        prompt = (
            f"{situation}"
            f"You may only pick from this library (id: artist - title (tempo, genre)), listed in a set "
            f"order where neighbors flow into each other:\n{menu}\n"
            "Answer with library ids, in the order they should play. Prefer songs that haven't been played "
            "or queued; only repeat a song once every song has played, starting with the one played longest ago.\n"
            "Make it flow like a real DJ set: each song in the same or a neighboring genre as the one before "
            "(e.g. hip-hop to R&B, house to disco), never a drastic jump like trap straight into disco or "
            "EDM. Change genre one small step at a time, keep tempos close (or half/double time), and build "
            "energy gradually. Only make a big jump when the vibe asks for one.\n"
            f"Pick {count} songs."
        )
        # Songs already queued or played, by the "artist - title" label the page uses.
        label = lambda s: f"{clean(s.get('artist', ''), 80)} - {clean(s.get('title', ''), 120)}".lower()
        used = {clean(t, 200).lower() for t in [*request.get("queued", []), *request.get("played", [])]}
        unused = [s for s in library.values() if label(s) not in used]
        playing = next((s for s in library.values() if label(s) == clean(request.get("nowPlaying") or "", 200).lower()), None)
        order = {song_id: number for number, song_id in enumerate(library)}
        genre = lambda s: clean(s.get("genre", ""), 40).lower()

        def closest(after, choices):
            """The song that follows `after` best: same genre, then nearest tempo, then nearest in the set order."""
            if not after:
                return choices[0]
            here = order.get(clean(after.get("id", ""), 20), 0)
            return min(choices, key=lambda s: (
                genre(s) != genre(after),
                tempo_gap(bpm(after), bpm(s)),
                abs(order[clean(s.get("id", ""), 20)] - here),
            ))

        def entry(song, reason, intro):
            return {
                "id": song["id"],
                "artist": clean(song.get("artist", ""), 80),
                "title": clean(song.get("title", ""), 120),
                "reason": clean(reason, 160),
                "intro": clean(intro, 300),
            }

        try:
            gemini_picks = ask_gemini_for_picks(prompt, LIBRARY_PICK_SCHEMA)
        except DjError as error:
            print(f"[dj] Gemini unavailable ({error}): picking from the library", flush=True)
            gemini_picks, offline = [], str(error)
        # Every song played already: repeats are fine, the ones played longest ago first.
        fresh_left = bool(unused)
        if not fresh_left:
            played_order = {clean(t, 200).lower(): n for n, t in enumerate(request.get("played", []))}
            queued = {clean(t, 200).lower() for t in request.get("queued", [])}
            unused = sorted(
                (s for s in library.values() if label(s) not in queued),
                key=lambda s: played_order.get(label(s), -1),
            )[: max(count, len(library) // 2)]

        cleaned = []
        for pick in gemini_picks:
            song = library.get(clean(pick.get("id", ""), 20))
            if not song or any(p["id"] == song["id"] for p in cleaned):
                continue  # made-up or repeated id
            if label(song) in used and fresh_left:
                continue  # Gemini picked a repeat while fresh songs remain
            cleaned.append(entry(song, pick.get("reason", ""), pick.get("intro", "")))
            if len(cleaned) == count:
                break
        # Gemini came up short (repeats, bad ids): fill in with unused songs, each one
        # the closest match to the song before it.
        while len(cleaned) < count:
            choices = [s for s in unused if all(p["id"] != s["id"] for p in cleaned)]
            if not choices:
                break
            song = closest(library.get(cleaned[-1]["id"]) if cleaned else playing, choices)
            reason = "closest match (AI offline)" if offline else "keeps the set going"
            cleaned.append(entry(song, reason, f"Here's {song.get('title', '')} by {song.get('artist', '')}."))
    else:
        cleaned = []
        for pick in ask_gemini_for_picks(f"{situation}Pick {count} songs.", PICK_SCHEMA)[:count]:
            artist, title = clean(pick.get("artist", ""), 80), clean(pick.get("title", ""), 120)
            if artist and title:
                cleaned.append({
                    "artist": artist,
                    "title": title,
                    "reason": clean(pick.get("reason", ""), 160),
                    "intro": clean(pick.get("intro", ""), 300),
                })
    if not cleaned:
        raise DjError(offline or "Gemini didn't pick any songs")
    return cleaned, offline


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
        audio = post_json(url, {"text": text, "model_id": ELEVENLABS_MODEL}, {"xi-api-key": key}, timeout=AI_TIMEOUT)
        path.write_bytes(audio)
    return path


# ---- HTTP --------------------------------------------------------------------------

class Handler(SimpleHTTPRequestHandler):
    # Keep connections open between requests. With Python's default (HTTP/1.0, close
    # after every response), Windows often cut off the last ~32 KB of a song file and
    # hung for ~19 s before resetting: about half of all song loads failed.
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def home_is_landing(self):
        # The landing page is the home page (index.html is the hand tracker, ai-dj.html the AI DJ).
        parts = urlparse(self.path)
        if parts.path == "/":
            self.path = "/landing.html" + (f"?{parts.query}" if parts.query else "")

    def end_headers(self):
        # Always revalidate files, so edits show up on a normal reload (no stale cached scripts)
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_HEAD(self):
        self.home_is_landing()
        super().do_HEAD()

    def do_GET(self):
        self.home_is_landing()
        if self.path.startswith("/api/progress"):
            job = parse_qs(urlparse(self.path).query).get("job", [""])[0]
            with progress_lock:
                state = progress.get(job)
            return self.send_json(200, state or {"stage": "unknown"})
        super().do_GET()

    def log_message(self, format, *args):
        # The page polls progress several times a second; keep that out of the log.
        if not self.path.startswith("/api/progress"):
            super().log_message(format, *args)

    def do_POST(self):
        # Read the whole body first: on a kept-open connection, unread bytes would be
        # taken for the start of the next request.
        try:
            raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        except ValueError:
            self.close_connection = True
            return self.send_json(400, {"error": "invalid request body"})
        # Only our own pages may call the API (blocks other websites from using it, and
        # the keys, through your browser).
        origin = self.headers.get("Origin")
        if origin and urlparse(origin).netloc != self.headers.get("Host"):
            return self.send_json(403, {"error": "forbidden origin"})
        routes = {"/api/youtube": self.youtube, "/api/dj/pick": self.pick, "/api/dj/voice": self.voice}
        route = routes.get(self.path)
        if not route:
            return self.send_json(404, {"error": "not found"})
        try:
            body = json.loads(raw or b"{}")
            if not isinstance(body, dict):
                raise ValueError
        except (ValueError, json.JSONDecodeError):
            return self.send_json(400, {"error": "invalid request body"})
        route(body)

    def youtube(self, body):
        target = to_target(str(body.get("url", "")))
        if not target:
            return self.send_json(400, {"error": "paste a single YouTube video link, or type a song name"})
        job = re.sub(r"[^\w-]", "", str(body.get("job", "")))[:40]
        set_progress(job, stage="searching", percent=None)
        try:
            self.download_song(target, job)
        finally:
            with progress_lock:
                progress.pop(job, None)

    def download_song(self, target, job):
        entry, error = get_song(target, job)
        if entry:
            return self.send_json(200, entry)
        return self.send_json(502, {"error": error})

    def pick(self, body):
        try:
            picks, offline = dj_pick(body)
        except DjError as error:
            print(f"[dj] pick failed: {error}", flush=True)
            return self.send_json(502, {"error": str(error)})
        print(f"[dj] picked: {'; '.join(p['artist'] + ' - ' + p['title'] for p in picks)}", flush=True)
        self.send_json(200, {"picks": picks, "offline": offline})

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


class Server(ThreadingHTTPServer):
    # On Windows, SO_REUSEADDR lets a second server silently share a port that's
    # already taken, so requests go to whichever copy started first (wrong files, 404s).
    # Refuse the port instead, so the clash is obvious.
    allow_reuse_address = sys.platform != "win32"


if __name__ == "__main__":
    try:
        server = Server((HOST, PORT), Handler)
    except OSError:
        sys.exit(f"Port {PORT} is already in use (another server.py still running?)\n"
                 f"Stop it, or pick another port:  python server.py {PORT + 1}")
    print(f"AirDeck running at http://localhost:{PORT} (yt-dlp: {' '.join(YTDLP + JS_RUNTIME)})")
    gemini = f"on ({GEMINI_MODEL})" if os.environ.get("GEMINI_API_KEY") else "library picks only (set GEMINI_API_KEY for Gemini)"
    voice = "ElevenLabs" if os.environ.get("ELEVENLABS_API_KEY") else "browser voice (set ELEVENLABS_API_KEY for ElevenLabs)"
    print(f"AI DJ: {gemini}, voice: {voice}")
    server.serve_forever()
