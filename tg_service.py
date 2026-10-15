#!/usr/bin/env python3
"""
Telegram MTProto sender service
POST /send  { "teks": "..." }  → kirim ke @WacbBot via akun user 085388709607
GET  /      → health check { "status": "ok" }
"""
from http.server import HTTPServer, BaseHTTPRequestHandler
import json, asyncio, threading, os

from telethon import TelegramClient
from telethon.sessions import StringSession

API_ID      = 31670714
API_HASH    = '94cec71e7719a641c36d9aad0903c92d'
SESSION_STR = '1BVtsOI0Bu5u6f3WYldwkCjJdjsL18QI5_mm8233Z3OOTn46bjtqkTjfQl7NlULWwFk7_KZEO9PToAU1-HovxNh2Mo7kKpZAHJs1ZbXTdVw9xaxPpBJ95_-Ei9WdHGNn2pwx6poVhD1CwS4tKVlXpDYl5x8D84CQu2zvS21tbOlgdjpQmhTIM35_UJLKzDCEg33Mu_QAZODCeRulEWcKBcJmZcgYw8p0vjvBrrBX2TedX5q6zRrWiz-fqUjFBwBh5zfV6mmb9t1khY__CpJ8SF38sReLzWubUYkrcbWcvEqqhGJ5UF9K1SzRHVfd1O2rqQt2wcyN2UUczbu0V8aBqxUUIJETjNqQ='
TARGET      = 'WacbBot'
PORT        = int(os.environ.get('PORT', 4445))

# ── Event loop & persistent client ──────────────────────────────
loop   = asyncio.new_event_loop()
client = TelegramClient(StringSession(SESSION_STR), API_ID, API_HASH, loop=loop)

async def _start():
    await client.connect()
    print('Telethon connected', flush=True)

def run_loop():
    asyncio.set_event_loop(loop)
    loop.run_until_complete(_start())
    loop.run_forever()

threading.Thread(target=run_loop, daemon=True).start()

# Tunggu client connect sebelum terima request
import time
time.sleep(3)

# ── Send helper ──────────────────────────────────────────────────
async def send_message(teks):
    if not client.is_connected():
        await client.connect()
    await client.send_message(TARGET, teks)

# ── HTTP Handler ─────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # suppress default logs

    def _json(self, code, body: dict):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._json(200, {'status': 'ok'})

    def do_POST(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            body   = self.rfile.read(length)
            data   = json.loads(body)
            teks   = data.get('teks', '').strip()
            if not teks:
                self._json(400, {'success': False, 'error': 'teks kosong'})
                return
            future = asyncio.run_coroutine_threadsafe(send_message(teks), loop)
            future.result(timeout=30)
            self._json(200, {'success': True})
        except Exception as e:
            self._json(500, {'success': False, 'error': str(e)})

if __name__ == '__main__':
    print(f'Telegram MTProto service running on 0.0.0.0:{PORT}', flush=True)
    server = HTTPServer(('0.0.0.0', PORT), Handler)
    server.serve_forever()
