// prior-art workflow tier — reads `claude -p --output-format stream-json --verbose` output into the
// tool calls the scorer measures, keeping result bodies: a Grep result can read a span on its own.

import { z } from 'zod';

const toolInputSchema = z.looseObject({
  file_path: z.string().optional(),
  path: z.string().optional(),
  pattern: z.string().optional(),
  output_mode: z.string().optional(),
  offset: z.number().optional(),
  limit: z.number().optional(),
});
export type ToolInput = z.infer<typeof toolInputSchema>;

const blockSchema = z.looseObject({
  type: z.string(),
  id: z.string().optional(),
  name: z.string().default(''),
  input: toolInputSchema.default({}),
  tool_use_id: z.string().optional(),
  content: z
    .union([z.string(), z.array(z.looseObject({ text: z.string().default('') }))])
    .default(''),
  is_error: z.boolean().default(false),
});
type Block = z.infer<typeof blockSchema>;

const eventSchema = z.looseObject({
  type: z.string(),
  subtype: z.string().nullable().default(null),
  tools: z.array(z.string()).default([]),
  mcp_servers: z.array(z.looseObject({ name: z.string().default('unnamed') })).default([]),
  model: z.string().nullable().default(null),
  message: z.looseObject({ content: z.array(blockSchema).default([]) }).optional(),
  result: z.string().default(''),
  is_error: z.boolean().default(false),
  total_cost_usd: z.number().nullable().default(null),
  permission_denials: z
    .array(z.looseObject({ tool_name: z.string().default('unknown') }))
    .default([]),
});
type ClaudeEvent = z.infer<typeof eventSchema>;

export interface ToolCall {
  id: string;
  name: string;
  input: ToolInput;
  result: string | null;
  isError: boolean;
}

/** What the `system/init` event says the session actually had. */
export interface TraceInit {
  tools: string[];
  mcpServers: string[];
  model: string | null;
}

export interface Trace {
  init: TraceInit | null;
  calls: ToolCall[];
  denials: string[];
  /** The final `result` event's text, or null when the session ended without one. */
  result: string | null;
  isError: boolean;
  subtype: string | null;
  costUsd: number | null;
}

function events(stream: string): ClaudeEvent[] {
  const parsed: ClaudeEvent[] = [];
  for (const line of stream.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const event = eventSchema.safeParse(JSON.parse(line));
      if (event.success) parsed.push(event.data);
    } catch {
      // A torn final line from a killed session carries nothing the scorer needs.
    }
  }
  return parsed;
}

function resultText(content: Block['content']): string {
  return Array.isArray(content) ? content.map((part) => part.text).join('\n') : content;
}

/** Open a call on each tool_use and close it on the matching tool_result. */
function recordBlocks(blocks: Block[], byId: Map<string, ToolCall>, calls: ToolCall[]): void {
  for (const block of blocks) {
    if (block.type === 'tool_use' && block.id) {
      const call = {
        id: block.id,
        name: block.name,
        input: block.input,
        result: null,
        isError: false,
      };
      byId.set(block.id, call);
      calls.push(call);
    }
    const answered =
      block.type === 'tool_result' && block.tool_use_id && byId.get(block.tool_use_id);
    if (answered) {
      answered.result = resultText(block.content);
      answered.isError = block.is_error;
    }
  }
}

export function parseTrace(stream: string): Trace {
  const trace: Trace = {
    init: null,
    calls: [],
    denials: [],
    result: null,
    isError: false,
    subtype: null,
    costUsd: null,
  };
  const byId = new Map<string, ToolCall>();
  for (const event of events(stream)) {
    if (event.type === 'system' && event.subtype === 'init') {
      const mcpServers = event.mcp_servers.map((server) => server.name);
      trace.init = { tools: event.tools, mcpServers, model: event.model };
    }
    recordBlocks(event.message?.content ?? [], byId, trace.calls);
    if (event.type === 'result')
      Object.assign(trace, {
        result: event.result.trim() ? event.result : null,
        isError: event.is_error,
        subtype: event.subtype,
        costUsd: event.total_cost_usd,
        denials: event.permission_denials.map((denial) => denial.tool_name),
      });
  }
  return trace;
}
