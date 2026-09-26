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
from pathlib import Path
import uuid

from aiohttp import ClientSession, ClientTimeout, web
from dotenv import load_dotenv

# Local development config is optional; deployed services use injected environment variables.
load_dotenv(Path(__file__).with_name(".env"))

MAX_BODY = 48_000
MAX_MESSAGES = 24
MAX_TEXT = 12_000
SESSION_TTL = 8 * 60 * 60
attempts = defaultdict(deque)
usage = defaultdict(deque)
global_usage = deque()
antigravity_sessions = {}
antigravity_locks = defaultdict(asyncio.Lock)


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
    return {"Access-Control-Allow-Origin": origin or next(iter(allowed)), "Vary": "Origin", "Access-Control-Allow-Headers": "Authorization,Content-Type,X-Conversation-ID", "Access-Control-Allow-Methods": "GET,POST,OPTIONS"}


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
    provider = os.getenv("CHAT_PROVIDER", "antigravity").strip().lower()
    configured = provider == "mock" or (provider in ("google", "gemini") and bool(os.getenv("GOOGLE_API_KEY") and os.getenv("GOOGLE_MODEL"))) or (provider == "antigravity" and bool(os.getenv("GOOGLE_API_KEY")))
    return web.json_response({"ok": True, "provider": provider, "providerConfigured": configured})


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


async def write_event(response, value):
    await response.write(f"data: {json.dumps(value)}\n\n".encode())


async def chat_route(request):
    auth = request.headers.get("Authorization", "")
    bearer = auth[7:] if auth.startswith("Bearer ") else ""
    if not valid_token(bearer):
        raise web.HTTPUnauthorized(text='{"error":"Your session expired. Enter the code again."}', content_type="application/json")
    session_key = hashlib.sha256(bearer.encode()).hexdigest()
    raw_conversation_id = request.headers.get("X-Conversation-ID", "")
    try:
        conversation_id = str(uuid.UUID(raw_conversation_id))
    except (ValueError, AttributeError):
        raise web.HTTPBadRequest(text='{"error":"A valid conversation ID is required."}', content_type="application/json")
    rate_check(usage, session_key, 30, 3600)
    utc_day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    now = time.time()
    cap = int(os.getenv("MAX_DAILY_REQUESTS", "250"))
    while global_usage and global_usage[0][1] != utc_day:
        global_usage.popleft()
    if len(global_usage) >= cap:
        raise web.HTTPTooManyRequests(text='{"error":"The daily chat limit has been reached. Please try again tomorrow."}', content_type="application/json")
    data = await read_json(request)
    messages = get_messages(data)
    global_usage.append((now, utc_day))
    provider = os.getenv("CHAT_PROVIDER", "antigravity").strip().lower()
    response = web.StreamResponse(status=200, headers={**cors_headers(request), "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})
    await response.prepare(request)
    try:
        if provider == "mock":
            async with antigravity_locks[session_key]:
                antigravity_sessions.pop(session_key, None)
                answer = "MOCK REPLY (local only): " + messages[-1]["parts"][0]["text"]
                for start in range(0, len(answer), 12):
                    await write_event(response, {"delta": answer[start:start + 12]})
                    await asyncio.sleep(0.025)
        elif provider in ("google", "gemini"):
            async with antigravity_locks[session_key]:
                antigravity_sessions.pop(session_key, None)
                await stream_gemini(response, messages)
        elif provider == "antigravity":
            async with antigravity_locks[session_key]:
                await stream_antigravity(response, session_key, conversation_id, messages)
        else:
            await write_event(response, {"error": "CHAT_PROVIDER must be mock, antigravity, or gemini."})
    except (asyncio.CancelledError, ConnectionResetError):
        if provider == "antigravity":
            # A canceled interaction may have completed upstream after the client stopped.
            # Clear its cursor so the next request rebuilds from the visible completed turns.
            antigravity_sessions.pop(session_key, None)
        raise
    except Exception:
        try:
            await write_event(response, {"error": "The chat connection ended unexpectedly. Please try again."})
        except ConnectionResetError:
            pass
    try:
        await response.write(b"data: [DONE]\n\n")
    except ConnectionResetError:
        pass
    return response


async def stream_gemini(response, messages):
    api_key = secret("GOOGLE_API_KEY", 12)
    model = secret("GOOGLE_MODEL", 1)
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse"
    payload = {"systemInstruction": {"parts": [{"text": "You are a helpful, clear assistant in a developer portfolio chat. Keep answers useful and concise. This application currently supports text chat; do not claim that UI controls, tools, or voice are implemented."}]}, "contents": messages, "generationConfig": {"maxOutputTokens": 2048}}
    timeout = ClientTimeout(total=90, connect=10, sock_read=45)
    async with ClientSession(timeout=timeout) as session:
        async with session.post(url, json=payload, headers={"x-goog-api-key": api_key}) as upstream:
            if upstream.status != 200:
                await upstream.read()
                message = "The model quota is exhausted." if upstream.status == 429 else f"Gemini request failed (HTTP {upstream.status}). Check the API key and model name."
                await write_event(response, {"error": message})
                return
            async for raw in upstream.content:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                try:
                    obj = json.loads(line[5:].strip())
                    parts = obj.get("candidates", [{}])[0].get("content", {}).get("parts", [])
                    delta = "".join(p.get("text", "") for p in parts if isinstance(p.get("text"), str))
                    if delta:
                        await write_event(response, {"delta": delta})
                except (ValueError, IndexError, AttributeError):
                    continue


async def stream_antigravity(response, session_key, conversation_id, messages):
    api_key = secret("GOOGLE_API_KEY", 12)
    agent = os.getenv("ANTIGRAVITY_AGENT", "antigravity-preview-09-2026")
    state = antigravity_sessions.get(session_key)
    if not state or state.get("provider") != "antigravity" or state.get("conversation_id") != conversation_id:
        state = None
        prompt = "\n".join(("Assistant" if m["role"] == "model" else "User") + ": " + m["parts"][0]["text"] for m in messages)
        environment = "remote"
        previous_id = None
    else:
        prompt = messages[-1]["parts"][0]["text"]
        environment = state["environment_id"]
        previous_id = state["interaction_id"]
    payload = {
        "agent": agent,
        "input": prompt,
        "environment": environment,
        "stream": True,
        "tools": [],
        "system_instruction": "You are a helpful general-purpose assistant in a developer portfolio chat. Keep answers clear and concise. You are chat-only: do not execute code, browse, access files, or claim this app has UI controls, WebMCP, or voice features.",
    }
    if previous_id:
        payload["previous_interaction_id"] = previous_id
    model = os.getenv("ANTIGRAVITY_MODEL", "").strip()
    if model:
        payload["agent_config"] = {"type": "antigravity", "model": model}
    url = "https://generativelanguage.googleapis.com/v1beta/interactions"
    timeout = ClientTimeout(total=180, connect=10, sock_read=90)
    interaction_id = None
    environment_id = state.get("environment_id") if state else None
    completed = False
    async with ClientSession(timeout=timeout) as session:
        async with session.post(url, json=payload, headers={"x-goog-api-key": api_key}) as upstream:
            if upstream.status != 200:
                await upstream.read()
                message = "The Antigravity quota is exhausted." if upstream.status == 429 else f"Antigravity request failed (HTTP {upstream.status}). Check API access and agent configuration."
                await write_event(response, {"error": message})
                return
            async for raw in upstream.content:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    event = json.loads(data)
                except ValueError:
                    continue
                event_type = event.get("event_type") or event.get("type")
                interaction = event.get("interaction") or {}
                if interaction.get("id"):
                    interaction_id = interaction["id"]
                if interaction.get("environment_id"):
                    environment_id = interaction["environment_id"]
                if event_type == "step.delta":
                    delta = event.get("delta") or {}
                    if delta.get("type") == "text" and delta.get("text"):
                        await write_event(response, {"delta": delta["text"]})
                elif event_type == "interaction.completed":
                    completed = interaction.get("status", "completed") == "completed"
                    if completed:
                        antigravity_sessions[session_key] = {"provider": "antigravity", "conversation_id": conversation_id, "interaction_id": interaction_id, "environment_id": environment_id}
                    else:
                        await write_event(response, {"error": "Antigravity did not complete this response."})
                elif event_type in ("interaction.failed", "error"):
                    await write_event(response, {"error": "Antigravity could not complete this response. Check API access and quota."})
    if completed and interaction_id and not environment_id:
        # Lifecycle SSE payloads omit environment_id; fetch the full interaction once at turn end.
        async with ClientSession(timeout=ClientTimeout(total=15, connect=5)) as session:
            async with session.get(f"{url}/{interaction_id}", headers={"x-goog-api-key": api_key}) as detail:
                if detail.status == 200:
                    full_interaction = await detail.json()
                    environment_id = full_interaction.get("environment_id")
    if completed and interaction_id and environment_id:
        antigravity_sessions[session_key] = {"provider": "antigravity", "conversation_id": conversation_id, "interaction_id": interaction_id, "environment_id": environment_id}
    elif completed:
        antigravity_sessions.pop(session_key, None)
        await write_event(response, {"error": "Antigravity did not return conversation state; please start a new chat session."})


def create_app():
    app = web.Application(middlewares=[security], client_max_size=MAX_BODY)
    app.router.add_get("/healthz", health)
    app.router.add_post("/api/session", session_route)
    app.router.add_post("/api/chat", chat_route)
    app.router.add_route("OPTIONS", "/{tail:.*}", lambda request: web.Response(status=204))
    return app


if __name__ == "__main__":
    web.run_app(create_app(), host="0.0.0.0", port=int(os.getenv("PORT", "8080")))
