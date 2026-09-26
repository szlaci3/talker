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
speech_usage = defaultdict(deque)
global_usage = deque()
antigravity_sessions = {}
antigravity_locks = defaultdict(asyncio.Lock)
speech_gate = asyncio.Semaphore(2)
speech_catalogue = []
speech_catalogue_at = 0.0
speech_audio_cache = {}
PREFERRED_EDGE_VOICE = "en-US-BrianMultilingualNeural"
MAX_SPEECH_TEXT = 1800
MAX_SPEECH_AUDIO = 1_500_000
UI_TOOLS = [
    {"type": "function", "name": "set_theme", "description": "Set the chat theme to light, dark, or system.", "parameters": {"type": "object", "properties": {"theme": {"type": "string", "enum": ["system", "light", "dark"]}}, "required": ["theme"]}},
    {"type": "function", "name": "set_font_scale", "description": "Set chat text size from 0.85 (smaller) to 1.3 (larger), where 1 is the default.", "parameters": {"type": "object", "properties": {"scale": {"type": "number", "minimum": 0.85, "maximum": 1.3}}, "required": ["scale"]}},
    {"type": "function", "name": "set_ui_color", "description": "Change one named chat UI color. Convert the user's natural-language color request to a six-digit hex color. For a follow-up, adjust the previously changed target. Use readable text colors.", "parameters": {"type": "object", "properties": {"target": {"type": "string", "enum": ["pageBackground", "headerBackground", "messageBackground", "userMessageBackground", "composerBackground", "primaryText", "mutedText", "accent", "composerText"]}, "color": {"type": "string", "pattern": "^#[0-9A-Fa-f]{6}$"}}, "required": ["target", "color"]}},
    {"type": "function", "name": "get_ui_preferences", "description": "Read the current theme, font size, and chat colors before making a requested appearance change.", "parameters": {"type": "object", "properties": {}}},
    {"type": "function", "name": "reset_ui", "description": "Reset the theme, font size, and chat colors to their defaults.", "parameters": {"type": "object", "properties": {}}},
]
MAX_UI_TOOL_CALLS = 4
UI_COLOR_TARGETS = {"pageBackground", "headerBackground", "messageBackground", "userMessageBackground", "composerBackground", "primaryText", "mutedText", "accent", "composerText"}


def valid_ui_tool_call(name, arguments):
    if not isinstance(name, str) or not isinstance(arguments, dict):
        return False
    if name == "set_theme":
        return set(arguments) == {"theme"} and arguments["theme"] in {"system", "light", "dark"}
    if name == "set_font_scale":
        value = arguments.get("scale")
        return set(arguments) == {"scale"} and isinstance(value, (int, float)) and not isinstance(value, bool) and 0.85 <= value <= 1.3
    if name == "set_ui_color":
        return set(arguments) == {"target", "color"} and arguments.get("target") in UI_COLOR_TARGETS and isinstance(arguments.get("color"), str) and len(arguments["color"]) == 7 and arguments["color"].startswith("#") and all(char in "0123456789abcdefABCDEF" for char in arguments["color"][1:])
    return name in {"get_ui_preferences", "reset_ui"} and set(arguments) == set()


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


def count_model_request(session_key):
    rate_check(usage, session_key, 30, 3600)
    utc_day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    now = time.time()
    cap = int(os.getenv("MAX_DAILY_REQUESTS", "250"))
    while global_usage and global_usage[0][1] != utc_day:
        global_usage.popleft()
    if len(global_usage) >= cap:
        raise web.HTTPTooManyRequests(text='{"error":"The daily chat limit has been reached. Please try again tomorrow."}', content_type="application/json")
    global_usage.append((now, utc_day))


def request_identity(request):
    session_key = authenticated_session(request)
    raw_conversation_id = request.headers.get("X-Conversation-ID", "")
    try:
        conversation_id = str(uuid.UUID(raw_conversation_id))
    except (ValueError, AttributeError):
        raise web.HTTPBadRequest(text='{"error":"A valid conversation ID is required."}', content_type="application/json")
    return session_key, conversation_id


def authenticated_session(request):
    auth = request.headers.get("Authorization", "")
    bearer = auth[7:] if auth.startswith("Bearer ") else ""
    if not valid_token(bearer):
        raise web.HTTPUnauthorized(text='{"error":"Your session expired. Enter the code again."}', content_type="application/json")
    return hashlib.sha256(bearer.encode()).hexdigest()


async def speech_voices_route(request):
    global speech_catalogue, speech_catalogue_at
    authenticated_session(request)
    now = time.monotonic()
    if not speech_catalogue or now - speech_catalogue_at > 600:
        try:
            import edge_tts
            async with asyncio.timeout(15):
                entries = await edge_tts.list_voices()
            speech_catalogue = [entry for entry in entries if
                entry.get("ShortName") == PREFERRED_EDGE_VOICE and entry.get("Locale") == "en-US"]
            speech_catalogue_at = now
        except Exception:
            raise web.HTTPBadGateway(text='{"error":"The speech voice catalogue is unavailable."}', content_type="application/json")
    return web.json_response({
        "voices": [{"name": entry["ShortName"], "friendlyName": entry.get("FriendlyName", ""), "locale": entry["Locale"]}
                   for entry in speech_catalogue],
        "preferredVoiceAvailable": bool(speech_catalogue),
    }, headers={"Cache-Control": "no-store"})


async def speech_route(request):
    user_key = authenticated_session(request)
    data = await read_json(request)
    if not isinstance(data, dict):
        raise web.HTTPBadRequest(text='{"error":"Invalid speech request."}', content_type="application/json")
    text_value, voice = data.get("text"), data.get("voice")
    rate = data.get("rate", 1)
    if (not isinstance(text_value, str) or not text_value.strip() or len(text_value) > MAX_SPEECH_TEXT or
            voice != PREFERRED_EDGE_VOICE or isinstance(rate, bool) or not isinstance(rate, (int, float)) or
            not 0.75 <= rate <= 1.25):
        raise web.HTTPBadRequest(text='{"error":"Invalid speech text, voice, or rate."}', content_type="application/json")
    speech_usage_key = (user_key, "speech")
    rate_check(speech_usage, speech_usage_key, 60, 3600)
    cache_key = (text_value, voice, float(rate))
    audio = speech_audio_cache.get(cache_key)
    if audio is None:
        if not speech_catalogue or not any(entry.get("ShortName") == voice for entry in speech_catalogue):
            raise web.HTTPServiceUnavailable(text='{"error":"Connect to the speech service before playback."}', content_type="application/json")
        try:
            import edge_tts
            async with speech_gate:
                async with asyncio.timeout(25):
                    audio_bytes = bytearray()
                    communicate = edge_tts.Communicate(text_value, voice,
                        rate=f"{round((rate - 1) * 100):+d}%")
                    async for chunk in communicate.stream():
                        if chunk["type"] == "audio":
                            audio_bytes.extend(chunk["data"])
                            if len(audio_bytes) > MAX_SPEECH_AUDIO:
                                raise ValueError("Speech audio exceeded the response size limit.")
            if not audio_bytes:
                raise ValueError("Speech service returned no audio.")
            audio = bytes(audio_bytes)
            speech_audio_cache[cache_key] = audio
            while len(speech_audio_cache) > 16:
                speech_audio_cache.pop(next(iter(speech_audio_cache)))
        except Exception:
            raise web.HTTPBadGateway(text='{"error":"Speech synthesis failed. Try browser speech or retry."}', content_type="application/json")
    return web.Response(body=audio, content_type="audio/mpeg", headers={"Cache-Control": "private, no-store"})


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


async def options_route(request):
    return web.Response(status=204)


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
    session_key, conversation_id = request_identity(request)
    data = await read_json(request)
    messages = get_messages(data)
    count_model_request(session_key)
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


async def ui_tool_result_route(request):
    session_key, conversation_id = request_identity(request)
    data = await read_json(request)
    results = data.get("toolResults")
    if not isinstance(results, list) or not 1 <= len(results) <= MAX_UI_TOOL_CALLS:
        raise web.HTTPBadRequest(text='{"error":"UI tool results are invalid."}', content_type="application/json")
    async with antigravity_locks[session_key]:
        state = antigravity_sessions.get(session_key)
        calls = state.get("pending_tool_calls", []) if state and state.get("conversation_id") == conversation_id else []
        if len(results) != len(calls):
            raise web.HTTPConflict(text='{"error":"The UI action request has expired. Please try again."}', content_type="application/json")
        function_results = []
        for expected, supplied in zip(calls, results):
            if not isinstance(supplied, dict) or supplied.get("callId") != expected["id"] or not isinstance(supplied.get("result"), dict):
                raise web.HTTPBadRequest(text='{"error":"UI tool results are invalid."}', content_type="application/json")
            result = supplied["result"]
            if not isinstance(result.get("ok"), bool) or not isinstance(result.get("message"), str):
                raise web.HTTPBadRequest(text='{"error":"UI tool results are invalid."}', content_type="application/json")
            function_results.append({
                "type": "function_result",
                "name": expected["name"],
                "call_id": expected["id"],
                "result": {"ok": result["ok"], "message": result["message"][:500]},
            })

        count_model_request(session_key)
        api_key = secret("GOOGLE_API_KEY", 12)
        agent = os.getenv("ANTIGRAVITY_AGENT", "antigravity-preview-09-2026")
        payload = {
            "agent": agent,
            "previous_interaction_id": state["interaction_id"],
            "environment": state["environment_id"],
            "input": function_results,
            "stream": True,
            "tools": UI_TOOLS,
            "system_instruction": "You are a helpful general-purpose assistant in a developer portfolio chat. Keep answers clear and concise. You can change only the chat appearance using the declared UI functions. Call at most one UI function at a time, and use it only when the user clearly requests an appearance change or asks to inspect/reset it; normal chat and discussion about UI should not trigger a function. Never claim a change was applied unless its function result says it succeeded. Ask which component the user means when a color request has no clear target. Never execute code, browse, access files, or claim voice features.",
        }
        model = os.getenv("ANTIGRAVITY_MODEL", "").strip()
        if model:
            payload["agent_config"] = {"type": "antigravity", "model": model}
        url = "https://generativelanguage.googleapis.com/v1beta/interactions"
        response = web.StreamResponse(status=200, headers={**cors_headers(request), "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})
        await response.prepare(request)
        interaction_id = None
        environment_id = state["environment_id"]
        completed = False
        requires_action = False
        active_tool_call = None
        tool_calls = []
        invalid_tool_call = False
        failed = False
        try:
            async with ClientSession(timeout=ClientTimeout(total=180, connect=10, sock_read=90)) as session:
                async with session.post(url, json=payload, headers={"x-goog-api-key": api_key}) as upstream:
                    if upstream.status != 200:
                        await upstream.read()
                        message = "The Antigravity quota is exhausted." if upstream.status == 429 else f"Antigravity request failed (HTTP {upstream.status}). Check API access and agent configuration."
                        await write_event(response, {"error": message})
                    else:
                        async for raw in upstream.content:
                            line = raw.decode("utf-8", "replace").strip()
                            if not line.startswith("data:"):
                                continue
                            data_line = line[5:].strip()
                            if data_line == "[DONE]":
                                break
                            try:
                                event = json.loads(data_line)
                            except ValueError:
                                continue
                            event_type = event.get("event_type") or event.get("type")
                            interaction = event.get("interaction") or {}
                            if interaction.get("id"):
                                interaction_id = interaction["id"]
                            if interaction.get("environment_id"):
                                environment_id = interaction["environment_id"]
                            if event_type == "step.start":
                                step = event.get("step") or {}
                                if step.get("type") == "function_call":
                                    active_tool_call = {"id": step.get("id"), "name": step.get("name"), "arguments": ""}
                            elif event_type == "step.delta":
                                delta = event.get("delta") or {}
                                if delta.get("type") == "text" and delta.get("text"):
                                    await write_event(response, {"delta": delta["text"]})
                                elif active_tool_call and delta.get("type") == "arguments_delta":
                                    partial = delta.get("arguments", "")
                                    if isinstance(partial, str):
                                        active_tool_call["arguments"] += partial
                            elif event_type == "step.stop" and active_tool_call:
                                try:
                                    args = json.loads(active_tool_call["arguments"] or "{}")
                                except json.JSONDecodeError:
                                    args = None
                                if active_tool_call.get("id") and active_tool_call.get("name") and valid_ui_tool_call(active_tool_call["name"], args):
                                    tool_calls.append({**active_tool_call, "arguments": args})
                                else:
                                    invalid_tool_call = True
                                active_tool_call = None
                            elif event_type == "interaction.completed":
                                status = interaction.get("status", "completed")
                                completed = status == "completed"
                                requires_action = status == "requires_action"
                                failed = not completed and not requires_action
                            elif event_type in ("interaction.failed", "error"):
                                failed = True
            if (completed or requires_action) and interaction_id and not environment_id:
                async with ClientSession(timeout=ClientTimeout(total=15, connect=5)) as session:
                    async with session.get(f"{url}/{interaction_id}", headers={"x-goog-api-key": api_key}) as detail:
                        if detail.status == 200:
                            full_interaction = await detail.json()
                            environment_id = full_interaction.get("environment_id")
            if completed and interaction_id:
                antigravity_sessions[session_key] = {"provider": "antigravity", "conversation_id": conversation_id, "interaction_id": interaction_id, "environment_id": environment_id}
            elif requires_action and interaction_id and environment_id and tool_calls and not invalid_tool_call:
                if len(tool_calls) > MAX_UI_TOOL_CALLS:
                    antigravity_sessions.pop(session_key, None)
                    await write_event(response, {"error": "The assistant requested too many UI changes at once."})
                else:
                    antigravity_sessions[session_key] = {
                        "provider": "antigravity",
                        "conversation_id": conversation_id,
                        "interaction_id": interaction_id,
                        "environment_id": environment_id,
                        "pending_tool_calls": tool_calls,
                    }
                    await write_event(response, {"tool_calls": tool_calls})
            elif requires_action:
                antigravity_sessions.pop(session_key, None)
                await write_event(response, {"error": "Antigravity requested an unsupported UI action."})
            elif not completed:
                antigravity_sessions.pop(session_key, None)
                await write_event(response, {"error": "Antigravity could not complete the UI action response." if failed else "Antigravity did not complete the UI action response."})
        except (asyncio.CancelledError, ConnectionResetError):
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
        "tools": UI_TOOLS,
        "system_instruction": "You are a helpful general-purpose assistant in a developer portfolio chat. Keep answers clear and concise. You can change only the chat appearance using the declared UI functions. Call at most one UI function at a time, and use it only when the user clearly requests an appearance change or asks to inspect/reset it; normal chat and discussion about UI should not trigger a function. Never claim a change was applied unless its function result says it succeeded. Ask which component the user means when a color request has no clear target. Never execute code, browse, access files, or claim voice features.",
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
    requires_action = False
    active_tool_call = None
    tool_calls = []
    invalid_tool_call = False
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
                if event_type == "step.start":
                    step = event.get("step") or {}
                    if step.get("type") == "function_call":
                        active_tool_call = {"id": step.get("id"), "name": step.get("name"), "arguments": ""}
                elif event_type == "step.delta":
                    delta = event.get("delta") or {}
                    if delta.get("type") == "text" and delta.get("text"):
                        await write_event(response, {"delta": delta["text"]})
                    elif active_tool_call and delta.get("type") == "arguments_delta":
                        partial = delta.get("arguments", "")
                        if isinstance(partial, str):
                            active_tool_call["arguments"] += partial
                elif event_type == "step.stop" and active_tool_call:
                    try:
                        args = json.loads(active_tool_call["arguments"] or "{}")
                    except json.JSONDecodeError:
                        args = None
                    if active_tool_call.get("id") and active_tool_call.get("name") and valid_ui_tool_call(active_tool_call["name"], args):
                        tool_calls.append({**active_tool_call, "arguments": args})
                    else:
                        invalid_tool_call = True
                    active_tool_call = None
                elif event_type == "interaction.completed":
                    status = interaction.get("status", "completed")
                    completed = status == "completed"
                    requires_action = status == "requires_action"
                    if completed:
                        antigravity_sessions[session_key] = {"provider": "antigravity", "conversation_id": conversation_id, "interaction_id": interaction_id, "environment_id": environment_id}
                    elif not requires_action:
                        await write_event(response, {"error": "Antigravity did not complete this response."})
                elif event_type in ("interaction.failed", "error"):
                    await write_event(response, {"error": "Antigravity could not complete this response. Check API access and quota."})
    if (completed or requires_action) and interaction_id and not environment_id:
        # Lifecycle SSE payloads omit environment_id; fetch the full interaction once at turn end.
        async with ClientSession(timeout=ClientTimeout(total=15, connect=5)) as session:
            async with session.get(f"{url}/{interaction_id}", headers={"x-goog-api-key": api_key}) as detail:
                if detail.status == 200:
                    full_interaction = await detail.json()
                    environment_id = full_interaction.get("environment_id")
    if requires_action and interaction_id and environment_id and tool_calls and not invalid_tool_call:
        if len(tool_calls) > MAX_UI_TOOL_CALLS:
            antigravity_sessions.pop(session_key, None)
            await write_event(response, {"error": "The assistant requested too many UI changes at once."})
            return
        antigravity_sessions[session_key] = {
            "provider": "antigravity",
            "conversation_id": conversation_id,
            "interaction_id": interaction_id,
            "environment_id": environment_id,
            "pending_tool_calls": tool_calls,
        }
        await write_event(response, {"tool_calls": tool_calls})
    elif completed and interaction_id and environment_id:
        antigravity_sessions[session_key] = {"provider": "antigravity", "conversation_id": conversation_id, "interaction_id": interaction_id, "environment_id": environment_id}
    elif completed:
        antigravity_sessions.pop(session_key, None)
        await write_event(response, {"error": "Antigravity did not return conversation state; please start a new chat session."})
    elif requires_action:
        antigravity_sessions.pop(session_key, None)
        await write_event(response, {"error": "Antigravity requested an unsupported UI action."})


def create_app():
    app = web.Application(middlewares=[security], client_max_size=MAX_BODY)
    app.router.add_get("/healthz", health)
    app.router.add_post("/api/session", session_route)
    app.router.add_post("/api/chat", chat_route)
    app.router.add_post("/api/ui-tool-result", ui_tool_result_route)
    app.router.add_get("/api/voices", speech_voices_route)
    app.router.add_post("/api/speech", speech_route)
    app.router.add_route("OPTIONS", "/{tail:.*}", options_route)
    return app


if __name__ == "__main__":
    web.run_app(create_app(), host="0.0.0.0", port=int(os.getenv("PORT", "8080")))
