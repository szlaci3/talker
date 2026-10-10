import asyncio
import os
import sys
import time
import types
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

from aiohttp.test_utils import TestClient, TestServer

import server


class FakeCommunicate:
    calls = []

    def __init__(self, text, voice, rate):
        self.calls.append((text, voice, rate))

    async def stream(self):
        yield {"type": "audio", "data": b"fake-mp3"}


class FakeTokenResponse:
    status = 200
    body = {"name": "single-use-live-token"}

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False

    async def text(self):
        import json
        return json.dumps(self.body)


class FakeTokenClient:
    calls = []

    def __init__(self, **_kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False

    def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return FakeTokenResponse()


async def fake_list_voices():
    return [
        {"ShortName": server.PREFERRED_EDGE_VOICE, "Locale": "en-US", "FriendlyName": "Brian"},
        {"ShortName": "en-GB-LibbyNeural", "Locale": "en-GB", "FriendlyName": "Libby"},
    ]


class SpeechRoutesTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.env = patch.dict(os.environ, {"SESSION_SECRET": "test-secret-value-with-at-least-32-bytes", "ALLOWED_ORIGINS": "http://localhost:5173"})
        self.env.start()
        FakeTokenClient.calls.clear()
        FakeTokenResponse.status = 200
        FakeTokenResponse.body = {"name": "single-use-live-token"}
        FakeCommunicate.calls.clear()
        server.speech_catalogue = []
        server.speech_catalogue_at = 0
        server.speech_audio_cache.clear()
        server.speech_usage.clear()
        self.token = server.token_for(int(time.time()) + 600)
        fake_edge_tts = types.SimpleNamespace(list_voices=fake_list_voices, Communicate=FakeCommunicate)
        self.edge_patch = patch.dict(sys.modules, {"edge_tts": fake_edge_tts})
        self.edge_patch.start()
        self.client = TestClient(TestServer(server.create_app()))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        self.edge_patch.stop()
        self.env.stop()

    def headers(self):
        return {"Authorization": "Bearer " + self.token}

    async def test_voice_catalogue_is_authenticated_and_selects_only_the_preferred_voice(self):
        denied = await self.client.get("/api/voices")
        self.assertEqual(denied.status, 401)

        response = await self.client.get("/api/voices", headers=self.headers())
        self.assertEqual(response.status, 200)
        body = await response.json()
        self.assertTrue(body["preferredVoiceAvailable"])
        self.assertEqual([voice["name"] for voice in body["voices"]], [server.PREFERRED_EDGE_VOICE])

    async def test_synthesis_validates_voice_and_returns_cached_mp3(self):
        headers = {**self.headers(), "Content-Type": "application/json"}
        invalid = await self.client.post("/api/speech", headers=headers, json={
            "text": "A short test.", "voice": "en-GB-LibbyNeural", "rate": 1,
        })
        self.assertEqual(invalid.status, 400)

        catalogue = await self.client.get("/api/voices", headers=self.headers())
        self.assertEqual(catalogue.status, 200)

        payload = {"text": "A short test.", "voice": server.PREFERRED_EDGE_VOICE, "rate": 1}
        first = await self.client.post("/api/speech", headers=headers, json=payload)
        second = await self.client.post("/api/speech", headers=headers, json=payload)
        self.assertEqual(first.status, 200)
        self.assertEqual(first.headers["Content-Type"], "audio/mpeg")
        self.assertEqual(await first.read(), b"fake-mp3")
        self.assertEqual(await second.read(), b"fake-mp3")
        self.assertEqual(len(FakeCommunicate.calls), 1)

    async def test_live_token_is_authenticated_constrained_and_keeps_api_key_server_side(self):
        with patch.dict(os.environ, {"GOOGLE_API_KEY": "server-only-test-google-key"}), patch.object(server, "ClientSession", FakeTokenClient):
            denied = await self.client.post("/api/live-token")
            self.assertEqual(denied.status, 401)
            response = await self.client.post("/api/live-token", headers=self.headers())
        self.assertEqual(response.status, 200)
        self.assertEqual(await response.json(), {"token": "single-use-live-token"})
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual(len(FakeTokenClient.calls), 1)
        url, request = FakeTokenClient.calls[0]
        self.assertEqual(url, "https://generativelanguage.googleapis.com/v1beta/auth_tokens")
        self.assertEqual(request["headers"]["x-goog-api-key"], "server-only-test-google-key")
        # Wire contract from Google's v1beta discovery schema (2026-10-04):
        # https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta
        # SDK-only liveConnectConstraints/config nesting causes HTTP 400.
        payload = request["json"]
        self.assertEqual(set(payload), {
            "uses", "expireTime", "newSessionExpireTime", "fieldMask", "bidiGenerateContentSetup",
        })
        self.assertEqual(payload["uses"], 1)
        self.assertEqual(payload["bidiGenerateContentSetup"], {
            "model": "models/gemini-3.5-transcribe-live",
            "generationConfig": {"responseModalities": ["TEXT"]},
            "inputAudioTranscription": {"languageCodes": []},
        })
        # An absent mask would ignore the browser's entire setup, including resumption.
        self.assertEqual(set(payload["fieldMask"].split(",")), {
            "model", "generationConfig", "inputAudioTranscription",
        })
        now = datetime.now(timezone.utc)
        for field, maximum in [("expireTime", 1800), ("newSessionExpireTime", 60)]:
            remaining = (datetime.fromisoformat(payload[field]) - now).total_seconds()
            self.assertGreater(remaining, maximum - 10)
            self.assertLessEqual(remaining, maximum)

    async def test_live_token_provider_error_is_actionable_and_redacts_the_api_key(self):
        FakeTokenResponse.status = 400
        FakeTokenResponse.body = {"error": {"message": "API key server-only-test-google-key cannot use this configuration."}}
        with patch.dict(os.environ, {"GOOGLE_API_KEY": "server-only-test-google-key"}), patch.object(server, "ClientSession", FakeTokenClient):
            response = await self.client.post("/api/live-token", headers=self.headers())
        self.assertEqual(response.status, 502)
        error = (await response.json())["error"]
        self.assertIn("HTTP 400", error)
        self.assertIn("cannot use this configuration", error)
        self.assertNotIn("server-only-test-google-key", error)

    async def test_dialog_token_locks_native_audio_model_tools_and_instructions(self):
        with patch.dict(os.environ, {"GOOGLE_API_KEY": "server-only-test-google-key", "DIALOG_FREE_TIER_CONFIRMED": "true", "DIALOG_MODEL": "gemini-2.5-flash-native-audio-preview-12-2025"}), patch.object(server, "ClientSession", FakeTokenClient):
            denied = await self.client.post("/api/dialog-token")
            self.assertEqual(denied.status, 401)
            response = await self.client.post("/api/dialog-token", headers=self.headers())
        self.assertEqual(response.status, 200)
        body = await response.json()
        self.assertNotIn("server-only-test-google-key", str(body))
        setup = body["setup"]
        self.assertEqual(body["token"], "single-use-live-token")
        self.assertEqual(setup["model"], "models/gemini-2.5-flash-native-audio-preview-12-2025")
        self.assertEqual(setup["generationConfig"]["responseModalities"], ["AUDIO"])
        self.assertEqual(setup["inputAudioTranscription"], {})
        self.assertEqual(setup["outputAudioTranscription"], {})
        self.assertEqual(len(setup["tools"][0]["functionDeclarations"]), 5)
        self.assertEqual(setup["tools"][0]["functionDeclarations"][0]["parametersJsonSchema"], server.UI_TOOLS[0]["parameters"])
        self.assertIn("systemInstruction", setup)
        payload = FakeTokenClient.calls[0][1]["json"]
        self.assertEqual(setup, payload["bidiGenerateContentSetup"])
        self.assertEqual(set(payload["fieldMask"].split(",")), set(setup))
        self.assertEqual(payload["uses"], 1)
        self.assertEqual(response.headers["Cache-Control"], "no-store")

    async def test_dialog_fails_closed_when_free_tier_unconfirmed_or_model_invalid(self):
        for settings in [{"DIALOG_FREE_TIER_CONFIRMED": "false"}, {"DIALOG_FREE_TIER_CONFIRMED": "true", "DIALOG_MODEL": "gemini-2.5-flash-preview-native-audio-dialog"}]:
            with patch.dict(os.environ, {"GOOGLE_API_KEY": "server-only-test-google-key", **settings}), patch.object(server, "ClientSession", FakeTokenClient):
                response = await self.client.post("/api/dialog-token", headers=self.headers())
            self.assertEqual(response.status, 503)
        self.assertEqual(FakeTokenClient.calls, [])


if __name__ == "__main__":
    unittest.main()
