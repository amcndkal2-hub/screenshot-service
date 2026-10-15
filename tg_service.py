#!/usr/bin/env python3
"""
Telegram MTProto sender service
POST /send        { "teks": "..." }   -> kirim ke @WacbBot
POST /auth/send-code  { "phone": "+62..." }  -> minta OTP
POST /auth/sign-in    { "phone": "+62...", "code": "12345", "phone_hash": "..." } -> login & simpan session
GET  /            -> health check
"""
from http.server import HTTPServer, BaseHTTPRequestHandler
import json, asyncio, threading, os

from telethon import TelegramClient
from telethon.sessions import StringSession

API_ID      = 31670714
API_HASH    = '94cec71e7719a641c36d9aad0903c92d'
SESSION_STR = os.environ.get('TG_SESSION', '')  # kosong = login baru via /auth/send-code
TARGET      = 'WacbBot'
PORT        = int(os.environ.get('PORT', 4445))

# ── Event loop di thread terpisah ────────────────────────────────
loop = asyncio.new_event_loop()

def run_loop():
    asyncio.set_event_loop(loop)
    loop.run_forever()

threading.Thread(target=run_loop, daemon=True).start()

# ── Init client ──────────────────────────────────────────────────
client = None
phone_code_hash = {}  # simpan sementara untuk sign-in

async def _init_client():
    global client
    client = TelegramClient(StringSession(SESSION_STR), API_ID, API_HASH)
    await client.connect()
    if await client.is_user_authorized():
        me = await client.get_me()
        print(f'Telethon connected as {me.first_name} (+{me.phone})', flush=True)
    else:
        print('Telethon connected but NOT authorized - perlu login ulang', flush=True)

fut = asyncio.run_coroutine_threadsafe(_init_client(), loop)
try:
    fut.result(timeout=30)
except Exception as e:
    print(f'Telethon init error: {e}', flush=True)

# ── Helpers ──────────────────────────────────────────────────────
async def _send(teks):
    if not client.is_connected():
        await client.connect()
    await client.send_message(TARGET, teks)

async def _send_code(phone):
    if not client.is_connected():
        await client.connect()
    result = await client.send_code_request(phone)
    return result.phone_code_hash

async def _sign_in(phone, code, hash_):
    await client.sign_in(phone=phone, code=code, phone_code_hash=hash_)
    return client.session.save()

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
        self._json(200, {'status': 'ok'})

    def do_POST(self):
        path = self.path.split('?')[0]
        try:
            data = self._read_body()

            # ── /send ────────────────────────────────────────────
            if path == '/send':
                teks = data.get('teks', '').strip()
                if not teks:
                    self._json(400, {'success': False, 'error': 'teks kosong'})
                    return
                asyncio.run_coroutine_threadsafe(_send(teks), loop).result(timeout=30)
                self._json(200, {'success': True})

            # ── /auth/send-code ──────────────────────────────────
            elif path == '/auth/send-code':
                phone = data.get('phone', '+6285388709607')
                hash_ = asyncio.run_coroutine_threadsafe(_send_code(phone), loop).result(timeout=30)
                phone_code_hash[phone] = hash_
                self._json(200, {'success': True, 'phone': phone, 'phone_code_hash': hash_})

            # ── /auth/sign-in ────────────────────────────────────
            elif path == '/auth/sign-in':
                phone = data.get('phone', '+6285388709607')
                code  = str(data.get('code', ''))
                hash_ = data.get('phone_hash') or phone_code_hash.get(phone, '')
                if not code or not hash_:
                    self._json(400, {'success': False, 'error': 'code dan phone_hash wajib'})
                    return
                new_session = asyncio.run_coroutine_threadsafe(_sign_in(phone, code, hash_), loop).result(timeout=30)
                self._json(200, {'success': True, 'session': new_session})

            else:
                self._json(404, {'error': 'not found'})

        except Exception as e:
            self._json(500, {'success': False, 'error': str(e)})

if __name__ == '__main__':
    print(f'Telegram MTProto service running on 0.0.0.0:{PORT}', flush=True)
    HTTPServer(('0.0.0.0', PORT), Handler).serve_forever()
