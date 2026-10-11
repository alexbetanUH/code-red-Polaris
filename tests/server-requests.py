"""Exercise real HTTP handlers in memory; no sockets, downloads, or paid API calls."""
import importlib.util
import io
from pathlib import Path
from email.message import Message

spec = importlib.util.spec_from_file_location('server', Path(__file__).resolve().parents[1] / 'server.py')
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)
server.ask_gemini_for_picks = lambda *args: [{"artist": "Test", "title": "Fixture", "reason": "", "intro": ""}]

def request(raw, length=None, origin=None):
    handler = object.__new__(server.Handler)
    handler.path = '/api/dj/pick'
    handler.headers = Message()
    handler.headers['Host'] = 'localhost:8001'
    handler.headers['Content-Length'] = str(len(raw) if length is None else length)
    if origin:
        handler.headers['Origin'] = origin
    handler.rfile = io.BytesIO(raw)
    handler.close_connection = False
    result = []
    handler.send_json = lambda status, body: result.append((status, body))
    handler.do_POST()
    return result, handler.close_connection

failures = []
for raw, length in [(b'{"count":"oops"}', None), (b'{"queued":null}', None),
                    (b'{"library":42}', None), (b'{"played":{}}', None),
                    (b'\xff', None), (b'{}', -1), (b'{}', 2**30)]:
    try:
        result, closed = request(raw, length)
        assert result and result[0][0] in (400, 413), result
        if length is not None:
            assert closed
    except Exception as error:
        failures.append(f'{raw!r}, length={length}: {type(error).__name__}: {error}')
assert not failures, '\n'.join(failures)
assert request(b'{}', origin='https://example.com')[0][0][0] == 403
# Valid shape still reaches the picker; replace only the external service boundary.
server.ask_gemini_for_picks = lambda *args: [{'artist': 'Test', 'title': 'Fixture', 'reason': '', 'intro': ''}]
assert request(b'{"count":1}')[0][0][0] == 200
print('PASS: malformed API values/encoding/length return JSON errors; valid requests and origin protection work')
