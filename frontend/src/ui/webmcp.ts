export type WebMCPTool = { name: string };
export type WebMCPContext = {
  registerTool: (tool: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<void>;
  getTools: () => Promise<WebMCPTool[]>;
  executeTool: (tool: WebMCPTool, input?: unknown, options?: { signal?: AbortSignal }) => Promise<string>;
};

export async function executeNativeUiTool(
  context: WebMCPContext, tool: WebMCPTool, input: unknown, signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  try {
    return await context.executeTool(tool, input, { signal });
  } catch (cause) {
    // Chrome <155 parses a JSON string; this rejection occurs before tool execution.
    if (!(cause instanceof DOMException) || cause.name !== 'UnknownError'
      || !cause.message.startsWith('Failed to parse input arguments')) throw cause;
    signal.throwIfAborted();
    return context.executeTool(tool, JSON.stringify(input), { signal });
  }
}
