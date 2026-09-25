"""Small aiohttp chat API. Process counters are development guardrails, not durable quotas."""
import asyncio
import base64
import hashlib
import hmac
import json
import os
import time
from collections import defaultdict, deque
from datetime import datetime, timezone

from aiohttp import ClientSession, ClientTimeout, web

MAX_BODY = 48_000
MAX_MESSAGES = 24
MAX_TEXT = 12_000
SESSION_TTL = 8 * 60 * 60
attempts = defaultdict(deque)
usage = defaultdict(deque)
global_usage = deque()


def secret(name, minimum=1):
    value = os.environ.get(name, "")
    if len(value) < minimum:
        raise web.HTTPServiceUnavailable(text=json.dumps({"error": f"Server is missing {name}."}), content_type="application/json")
    return value


def token_for(expiry):
    payload = str(expiry).encode()
    signature = hmac.new(secret("SESSION_SECRET", 32).encode(), payload, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(payload + b"." + signature).decode().rstrip("=")


def valid_token(token):
    try:
        expiry, signature = base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)).split(b".", 1)
        expected = hmac.new(secret("SESSION_SECRET", 32).encode(), expiry, hashlib.sha256).digest()
        return int(expiry) > int(time.time()) and hmac.compare_digest(signature, expected)
    except (ValueError, TypeError):
        return False


def cors_headers(request):
    origin = request.headers.get("Origin", "")
    allowed = {x.strip() for x in os.getenv("ALLOWED_ORIGINS", "http://localhost:5173").split(",")}
    if origin and origin not in allowed:
        raise web.HTTPForbidden(text='{"error":"Origin is not allowed."}', content_type="application/json")
    return {"Access-Control-Allow-Origin": origin or next(iter(allowed)), "Vary": "Origin", "Access-Control-Allow-Headers": "Authorization,Content-Type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS"}


@web.middleware
async def security(request, handler):
    headers = cors_headers(request)
    if request.method == "OPTIONS":
        return web.Response(status=204, headers=headers)
    try:
        response = await handler(request)
    except web.HTTPException as exc:
        exc.headers.update(headers)
        raise
    response.headers.update(headers)
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


def rate_check(bucket, key, limit, window):
    now = time.time()
    entries = bucket[key]
    while entries and entries[0] < now - window:
        entries.popleft()
    if len(entries) >= limit:
        raise web.HTTPTooManyRequests(text='{"error":"Too many requests. Please wait and try again."}', content_type="application/json")
    entries.append(now)


async def read_json(request):
    if request.content_length and request.content_length > MAX_BODY:
        raise web.HTTPRequestEntityTooLarge(max_size=MAX_BODY, actual_size=request.content_length)
    try:
        return await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise web.HTTPBadRequest(text='{"error":"Expected JSON."}', content_type="application/json")


async def session_route(request):
    ip = request.remote or "unknown"
    rate_check(attempts, ip, 8, 600)
    data = await read_json(request)
    supplied = str(data.get("code", ""))[:256]
    expected = secret("INVITATION_CODE", 12)
    if not hmac.compare_digest(supplied, expected):
        raise web.HTTPUnauthorized(text='{"error":"That invitation code is not valid."}', content_type="application/json")
    return web.json_response({"token": token_for(int(time.time()) + SESSION_TTL), "expiresIn": SESSION_TTL})


async def health(request):
    provider = os.getenv("CHAT_PROVIDER", "google")
    return web.json_response({"ok": True, "provider": provider, "providerConfigured": provider == "mock" or bool(os.getenv("GOOGLE_API_KEY") and os.getenv("GOOGLE_MODEL"))})


def get_messages(data):
    messages = data.get("messages")
    if not isinstance(messages, list) or not 1 <= len(messages) <= MAX_MESSAGES:
        raise web.HTTPBadRequest(text='{"error":"Send between 1 and 24 messages."}', content_type="application/json")
    clean = []
    for item in messages:
        if not isinstance(item, dict) or item.get("role") not in ("user", "assistant") or not isinstance(item.get("content"), str):
            raise web.HTTPBadRequest(text='{"error":"Message format is invalid."}', content_type="application/json")
        text = item["content"].strip()
        if not text or len(text) > MAX_TEXT:
            raise web.HTTPBadRequest(text='{"error":"Messages must contain 1 to 12000 characters."}', content_type="application/json")
        clean.append({"role": "user" if item["role"] == "user" else "model", "parts": [{"text": text}]})
    if clean[-1]["role"] != "user":
        raise web.HTTPBadRequest(text='{"error":"The latest message must be from the user."}', content_type="application/json")
    return clean


async def chat_route(request):
    auth = request.headers.get("Authorization", "")
    bearer = auth[7:] if auth.startswith("Bearer ") else ""
    if not valid_token(bearer):
        raise web.HTTPUnauthorized(text='{"error":"Your session expired. Enter the code again."}', content_type="application/json")
    rate_check(usage, hashlib.sha256(bearer.encode()).hexdigest(), 30, 3600)
    utc_day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    now = time.time()
    cap = int(os.getenv("MAX_DAILY_REQUESTS", "250"))
    while global_usage and global_usage[0][1] != utc_day:
        global_usage.popleft()
    if len(global_usage) >= cap:
        raise web.HTTPTooManyRequests(text='{"error":"The daily chat limit has been reached. Please try again tomorrow."}', content_type="application/json")
    messages = get_messages(await read_json(request))
    global_usage.append((now, utc_day))
    response = web.StreamResponse(status=200, headers={**cors_headers(request), "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})
    await response.prepare(request)
    try:
        if os.getenv("CHAT_PROVIDER", "google") == "mock":
            answer = "MOCK REPLY (local only): " + messages[-1]["parts"][0]["text"]
            for start in range(0, len(answer), 12):
                await response.write(f"data: {json.dumps({'delta': answer[start:start + 12]})}\n\n".encode())
                await asyncio.sleep(0.025)
            await response.write(b"data: [DONE]\n\n")
            return response
        api_key = secret("GOOGLE_API_KEY", 12)
        model = secret("GOOGLE_MODEL", 1)
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse"
        payload = {"systemInstruction": {"parts": [{"text": "You are a helpful, clear assistant in a developer portfolio chat. Keep answers useful and concise. This application currently supports text chat; do not claim that UI controls, tools, or voice are implemented."}]}, "contents": messages, "generationConfig": {"maxOutputTokens": 2048}}
        timeout = ClientTimeout(total=90, connect=10, sock_read=45)
        async with ClientSession(timeout=timeout) as session:
            async with session.post(url, json=payload, headers={"x-goog-api-key": api_key}) as upstream:
                if upstream.status != 200:
                    await upstream.read()
                    message = "The model quota is exhausted." if upstream.status == 429 else "The model provider could not answer. Try again shortly."
                    await response.write(f"data: {json.dumps({'error': message})}\n\n".encode())
                else:
                    async for raw in upstream.content:
                        line = raw.decode("utf-8", "replace").strip()
                        if not line.startswith("data:"):
                            continue
                        try:
                            obj = json.loads(line[5:].strip())
                            parts = obj.get("candidates", [{}])[0].get("content", {}).get("parts", [])
                            delta = "".join(p.get("text", "") for p in parts if isinstance(p.get("text"), str))
                            if delta:
                                await response.write(f"data: {json.dumps({'delta': delta})}\n\n".encode())
                        except (ValueError, IndexError, AttributeError):
                            continue
    except (asyncio.CancelledError, ConnectionResetError):
        raise
    except Exception:
        try:
            await response.write(b'data: {"error":"The chat connection ended unexpectedly. Please try again."}\n\n')
        except ConnectionResetError:
            pass
    try:
        await response.write(b"data: [DONE]\n\n")
    except ConnectionResetError:
        pass
    return response


def create_app():
    app = web.Application(middlewares=[security], client_max_size=MAX_BODY)
    app.router.add_get("/healthz", health)
    app.router.add_post("/api/session", session_route)
    app.router.add_post("/api/chat", chat_route)
    app.router.add_route("OPTIONS", "/{tail:.*}", lambda request: web.Response(status=204))
    return app


if __name__ == "__main__":
    web.run_app(create_app(), host="0.0.0.0", port=int(os.getenv("PORT", "8080")))
