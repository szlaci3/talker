import { describe, expect, it, vi } from 'vitest';
import { executeNativeUiTool, WebMCPContext } from './webmcp';

const tool = { name: 'set_theme' };
const input = { theme: 'dark' };
const result = JSON.stringify({ ok: true });
const parseFailure = () => new DOMException('Failed to parse input arguments', 'UnknownError');

function setup() {
  const executeTool = vi.fn<WebMCPContext['executeTool']>();
  const context: WebMCPContext = { registerTool: vi.fn(), getTools: vi.fn(), executeTool };
  const controller = new AbortController();
  return { context, executeTool, controller, signal: controller.signal };
}

describe('native WebMCP argument compatibility', () => {
  it('uses object arguments once on newer browsers', async () => {
    const { context, executeTool, signal } = setup();
    executeTool.mockResolvedValue(result);
    expect(await executeNativeUiTool(context, tool, input, signal)).toBe(result);
    expect(executeTool).toHaveBeenCalledExactlyOnceWith(tool, input, { signal });
  });

  it('retries the Chrome 154 parse rejection with JSON and the same tool and signal', async () => {
    const { context, executeTool, signal } = setup();
    executeTool.mockRejectedValueOnce(parseFailure()).mockResolvedValueOnce(result);
    expect(await executeNativeUiTool(context, tool, input, signal)).toBe(result);
    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(executeTool).toHaveBeenNthCalledWith(1, tool, input, { signal });
    expect(executeTool).toHaveBeenNthCalledWith(2, tool, JSON.stringify(input), { signal });
  });

  it.each([
    new DOMException('Tool callback failed', 'UnknownError'),
    new DOMException('Execution canceled', 'AbortError'),
    new Error('Failed to parse input arguments'),
  ])('does not retry unrelated execution or cancellation errors: %s', async failure => {
    const { context, executeTool, signal } = setup();
    executeTool.mockRejectedValue(failure);
    await expect(executeNativeUiTool(context, tool, input, signal)).rejects.toBe(failure);
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it('does not retry again if JSON arguments also fail', async () => {
    const { context, executeTool, signal } = setup();
    const failure = parseFailure();
    executeTool.mockRejectedValue(failure);
    await expect(executeNativeUiTool(context, tool, input, signal)).rejects.toBe(failure);
    expect(executeTool).toHaveBeenCalledTimes(2);
  });

  it('does not retry if canceled while the object call is pending', async () => {
    const { context, executeTool, controller, signal } = setup();
    executeTool.mockImplementationOnce(async () => {
      controller.abort();
      throw parseFailure();
    });
    await expect(executeNativeUiTool(context, tool, input, signal)).rejects.toBe(signal.reason);
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it('does not execute an already canceled invocation', async () => {
    const { context, executeTool, controller, signal } = setup();
    controller.abort();
    await expect(executeNativeUiTool(context, tool, input, signal)).rejects.toBe(signal.reason);
    expect(executeTool).not.toHaveBeenCalled();
  });
});
