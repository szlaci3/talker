import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { waitForAntigravityRequestSlot } from '../test/antigravity-budget';
import App from './App';

const env = process.env;
const apiUrl = env.VITE_API_URL || 'http://localhost:8080';
const invitationCode = env.TALKER_LIVE_INVITATION_CODE;

it('gets a real Antigravity answer through the chat UI', async () => {
  if (env.TALKER_ENABLE_ANTIGRAVITY_LIVE !== '1') {
    throw new Error('Live calls are disabled. Set TALKER_ENABLE_ANTIGRAVITY_LIVE=1 explicitly.');
  }
  const api = new URL(apiUrl);
  if (api.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(api.hostname)) {
    throw new Error('Live tests are restricted to a locally running backend.');
  }
  if (!invitationCode) throw new Error('Set TALKER_LIVE_INVITATION_CODE for the local test session.');

  const healthResponse = await fetch(apiUrl + '/healthz');
  expect(healthResponse.ok).toBe(true);
  const health = await healthResponse.json() as { provider: string; providerConfigured: boolean };
  expect(health.provider).toBe('antigravity');
  expect(health.providerConfigured).toBe(true);

  const sessionResponse = await fetch(apiUrl + '/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: invitationCode }),
  });
  const session = await sessionResponse.json() as { token?: string; error?: string };
  expect(sessionResponse.ok, session.error).toBe(true);
  if (!session.token) throw new Error('Local session response did not include a token.');
  sessionStorage.setItem('chat-token', session.token);

  const nativeFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === '/api/chat') await waitForAntigravityRequestSlot();
    return nativeFetch(input, init);
  });

  const user = userEvent.setup();
  render(<App />);
  await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Reply with exactly TALKER_LIVE_OK and nothing else.');
  await user.click(screen.getByRole('button', { name: '↑' }));

  expect(await screen.findByText(/TALKER_LIVE_OK/, {}, { timeout: 175_000 })).toBeInTheDocument();
}, 180_000);
