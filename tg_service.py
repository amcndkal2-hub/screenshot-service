#!/usr/bin/env python3
"""
Telegram MTProto sender service (robust)

GET  /                 -> health check (+ status session)
POST /send             { "teks": "...", "session": "<opsional>" } -> kirim ke @WacbBot
POST /auth/send-code   { "phone": "+62..." }                      -> minta OTP (reset login client)
POST /auth/sign-in     { "phone", "code", "phone_hash", "password" } -> login, kembalikan session baru
POST /auth/reset                                                  -> buang session aktif di memori

Desain anti "AuthKeyDuplicated":
  * Session TIDAK di-hardcode di repo (env TG_SESSION / dikirim Worker per request / hasil sign-in).
  * Koneksi Telegram dibuka HANYA saat kirim lalu ditutup (connect -> send -> disconnect),
    dengan lock global, sehingga tidak ada koneksi persisten yang bentrok saat
    restart / deploy overlap / pergantian IP Render.
  * Session mati terdeteksi dan dilaporkan jelas (SESSION_DEAD), bukan crash.
Opsional: set env TG_TOKEN -> semua request POST wajib header X-Token.
"""
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import json, asyncio, threading, os

from telethon import TelegramClient
from telethon.sessions import StringSession
from telethon import errors

API_ID   = 31670714
API_HASH = '94cec71e7719a641c36d9aad0903c92d'
TARGET   = 'WacbBot'
PORT     = int(os.environ.get('PORT', 4445))
TOKEN    = os.environ.get('TG_TOKEN', '')

ACTIVE_SESSION = os.environ.get('TG_SESSION', '').strip()   # session aktif (memori)
DEAD_SESSIONS = set()                                         # session yang terbukti mati
phone_code_hash = {}
login_client = None                                           # client sementara saat login

# ── Event loop di thread terpisah ────────────────────────────────
loop = asyncio.new_event_loop()

def _run_loop():
    asyncio.set_event_loop(loop)
    loop.run_forever()

threading.Thread(target=_run_loop, daemon=True).start()

_lock = None
def _get_lock():
    global _lock
    if _lock is None:
        _lock = asyncio.Lock()
    return _lock

def run(coro, timeout=40):
    return asyncio.run_coroutine_threadsafe(coro, loop).result(timeout=timeout)

DEAD_ERRORS = (
    errors.AuthKeyDuplicatedError,
    errors.AuthKeyUnregisteredError,
    errors.SessionRevokedError,
    errors.SessionExpiredError,
    errors.UserDeactivatedError,
    errors.UserDeactivatedBanError,
)

class SessionDead(Exception):
    pass

# ── Kirim pesan: connect -> send -> disconnect ───────────────────
async def _send(teks, session_str):
    s = (session_str or ACTIVE_SESSION or '').strip()
    if not s:
        raise SessionDead('SESSION_DEAD: belum ada session. Lakukan login (/auth/send-code lalu /auth/sign-in).')
    if s in DEAD_SESSIONS:
        raise SessionDead('SESSION_DEAD: session sudah tidak valid, login ulang diperlukan.')
    async with _get_lock():
        client = TelegramClient(StringSession(s), API_ID, API_HASH)
        try:
            await client.connect()
            if not await client.is_user_authorized():
                DEAD_SESSIONS.add(s)
                raise SessionDead('SESSION_DEAD: session tidak terotorisasi, login ulang diperlukan.')
            await client.send_message(TARGET, teks)
        except DEAD_ERRORS as e:
            DEAD_SESSIONS.add(s)
            raise SessionDead(f'SESSION_DEAD: {type(e).__name__} - login ulang diperlukan.')
        finally:
            try:
                await client.disconnect()
            except Exception:
                pass

# ── Login flow (client sama untuk send-code & sign-in) ───────────
async def _send_code(phone):
    global login_client
    async with _get_lock():
        if login_client is not None:
            try:
                await login_client.disconnect()
            except Exception:
                pass
        login_client = TelegramClient(StringSession(''), API_ID, API_HASH)
        await login_client.connect()
        result = await login_client.send_code_request(phone)
        return result.phone_code_hash

async def _sign_in(phone, code, hash_, password=None):
    global login_client, ACTIVE_SESSION
    if login_client is None:
        raise Exception('Belum ada permintaan OTP. Panggil /auth/send-code dulu.')
    async with _get_lock():
        try:
            await login_client.sign_in(phone=phone, code=code, phone_code_hash=hash_)
        except errors.SessionPasswordNeededError:
            if not password:
                raise Exception('2FA_REQUIRED')
            await login_client.sign_in(password=password)
        sess = login_client.session.save()
        try:
            await login_client.disconnect()
        except Exception:
            pass
        login_client = None
        ACTIVE_SESSION = sess
        DEAD_SESSIONS.discard(sess)
        return sess

# ── HTTP Handler ─────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _json(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _read_body(self):
        length = int(self.headers.get('Content-Length', 0))
        return json.loads(self.rfile.read(length)) if length else {}

    def do_GET(self):
        self._json(200, {
            'status': 'ok',
            'has_session': bool(ACTIVE_SESSION),
            'session_dead': (ACTIVE_SESSION in DEAD_SESSIONS) if ACTIVE_SESSION else None,
        })

    def do_POST(self):
        path = self.path.split('?')[0]
        try:
            if TOKEN and self.headers.get('X-Token', '') != TOKEN:
                self._json(401, {'success': False, 'error': 'unauthorized'})
                return
            data = self._read_body()

            if path == '/send':
                teks = (data.get('teks') or '').strip()
                if not teks:
                    self._json(400, {'success': False, 'error': 'teks kosong'})
                    return
                try:
                    run(_send(teks, data.get('session')))
                except SessionDead as e:
                    self._json(200, {'success': False, 'error': str(e), 'session_dead': True})
                    return
                self._json(200, {'success': True})

            elif path == '/auth/send-code':
                phone = data.get('phone', '+6285388709607')
                hash_ = run(_send_code(phone))
                phone_code_hash[phone] = hash_
                self._json(200, {'success': True, 'phone': phone, 'phone_code_hash': hash_})

            elif path == '/auth/sign-in':
                phone = data.get('phone', '+6285388709607')
                code = str(data.get('code', ''))
                hash_ = data.get('phone_hash') or phone_code_hash.get(phone, '')
                password = data.get('password')
                if not code or not hash_:
                    self._json(400, {'success': False, 'error': 'code dan phone_hash wajib'})
                    return
                sess = run(_sign_in(phone, code, hash_, password))
                self._json(200, {'success': True, 'session': sess})

            elif path == '/auth/reset':
                global ACTIVE_SESSION
                ACTIVE_SESSION = ''
                self._json(200, {'success': True})

            else:
                self._json(404, {'error': 'not found'})

        except Exception as e:
            self._json(500, {'success': False, 'error': str(e)})

if __name__ == '__main__':
    print(f'Telegram MTProto service running on 0.0.0.0:{PORT}', flush=True)
    ThreadingHTTPServer(('0.0.0.0', PORT), Handler).serve_forever()
