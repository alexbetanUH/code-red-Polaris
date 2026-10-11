"""Downloads every song in setlist.txt ahead of time, so a demo starts instantly.

Run:  python prefetch.py              (or: python prefetch.py my-other-list.txt)

Songs already downloaded are skipped. Uses the same downloader as server.py, so the
queue and the AI DJ find these songs without going back to YouTube.
"""

import sys
from pathlib import Path

import server


def read_songs(path):
    lines = (line.strip() for line in path.read_text(encoding="utf-8").splitlines())
    return [line for line in lines if line and not line.startswith("#")]


def main():
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / "setlist.txt"
    songs = read_songs(path)
    failed = 0
    for number, song in enumerate(songs, 1):
        target = server.to_target(song)
        if not target:
            print(f"{number}/{len(songs)} SKIPPED (not a single video link or song name): {song}")
            failed += 1
            continue
        entry, error = server.get_song(target)
        print(f"{number}/{len(songs)} {'ok' if entry else 'FAILED'}: {entry['title'] if entry else f'{song}: {error}'}")
        failed += entry is None
    print(f"\n{len(songs) - failed} of {len(songs)} songs ready.")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
