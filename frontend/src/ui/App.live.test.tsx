import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { waitForAntigravityRequestSlot } from '../test/antigravity-budget';
import App from './App';

const env = process.env;
const apiUrl = env.VITE_API_URL || 'http://localhost:8080';
const invitationCode = env.TALKER_LIVE_INVITATION_CODE;

it('gets a real Antigravity answer and applies a conversational UI color change', async () => {
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
  const requestPaths: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    requestPaths.push(url.pathname);
    if (url.pathname === '/api/chat' || url.pathname === '/api/ui-tool-result') await waitForAntigravityRequestSlot();
    return nativeFetch(input, init);
  });

  const user = userEvent.setup();
  render(<App />);
  const textbox = screen.getByRole('textbox', { name: 'Message' });
  await user.type(textbox, 'Change the input box background to bright red (#ff0000), then reply with exactly TALKER_COLOR_TOOL_OK and nothing else.');
  await user.click(screen.getByRole('button', { name: '↑' }));
  await waitFor(() => {
    const answer = screen.getAllByText(/TALKER_COLOR_TOOL_OK/).find(element => element.closest('.assistant'));
    expect(answer).toBeDefined();
    expect(document.documentElement.style.getPropertyValue('--ui-composer-bg')).toBe('#ff0000');
    expect(screen.getByRole('button', { name: '↑' })).toBeInTheDocument();
  }, { timeout: 175_000 });

  await user.type(textbox, 'That red is too dark. Change that same input background to a light pink, then reply with exactly TALKER_COLOR_FOLLOWUP_OK and nothing else.');
  await user.click(screen.getByRole('button', { name: '↑' }));
  await waitFor(() => {
    const answer = screen.getAllByText(/TALKER_COLOR_FOLLOWUP_OK/).find(element => element.closest('.assistant'));
    expect(answer).toBeDefined();
    const color = document.documentElement.style.getPropertyValue('--ui-composer-bg');
    expect(color).not.toBe('');
    expect(color).not.toBe('#ff0000');
    expect(screen.getByRole('button', { name: '↑' })).toBeInTheDocument();
  }, { timeout: 175_000 });
  expect(requestPaths.filter(path => path === '/api/ui-tool-result')).toHaveLength(2);
}, 180_000);
