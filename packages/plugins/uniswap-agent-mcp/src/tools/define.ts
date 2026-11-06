import type { z } from 'zod';
import type { ToolDeps } from '../context.js';
import type { ToolName } from '../schemas.js';

export type ToolKind = 'read' | 'build' | 'plan';

export interface ToolDefinition<
  I extends z.AnyZodObject = z.AnyZodObject,
  O extends z.AnyZodObject = z.AnyZodObject
> {
  name: ToolName;
  title: string;
  description: string;
  kind: ToolKind;
  input: I;
  output: O;
  handler: (args: z.infer<I>, deps: ToolDeps) => Promise<z.input<O>>;
  /** Concise human summary returned as the text content next to structuredContent. */
  summarize: (output: z.infer<O>) => string;
}

export function defineTool<I extends z.AnyZodObject, O extends z.AnyZodObject>(
  def: ToolDefinition<I, O>
): ToolDefinition<I, O> {
  return def;
}

export const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
