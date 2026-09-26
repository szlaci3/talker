import asyncio
import os
import sys
import time
import types
import unittest
from unittest.mock import patch

from aiohttp.test_utils import TestClient, TestServer

import server


class FakeCommunicate:
    calls = []

    def __init__(self, text, voice, rate):
        self.calls.append((text, voice, rate))

    async def stream(self):
        yield {"type": "audio", "data": b"fake-mp3"}


async def fake_list_voices():
    return [
        {"ShortName": server.PREFERRED_EDGE_VOICE, "Locale": "en-US", "FriendlyName": "Brian"},
        {"ShortName": "en-GB-LibbyNeural", "Locale": "en-GB", "FriendlyName": "Libby"},
    ]


class SpeechRoutesTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.env = patch.dict(os.environ, {"SESSION_SECRET": "test-secret-value-with-at-least-32-bytes", "ALLOWED_ORIGINS": "http://localhost:5173"})
        self.env.start()
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


if __name__ == "__main__":
    unittest.main()
