import type { Context } from '@deepseek-ai/cordis'
import {
  ToolCallId,
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

const HIGH = ReasoningEffortId('high')
const OFF = ReasoningEffortId('off')

/** Keyless searxng-profile adapter: one `web_search` call, then echo the source snippet. */
class SearxngMockAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [
          { id: OFF, name: 'Off' },
          { id: HIGH, name: 'High' },
        ],
        defaultEffort: HIGH,
      },
    }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const last = options.messages.at(-1)
    const toolResult = last?.role === 'tool' ? last : undefined
    if (toolResult === undefined) {
      const args = JSON.stringify({ queries: ['fixture query'] })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: ToolCallId('searxng-smoke-call'), name: 'web_search', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('searxng-smoke-call'), name: 'web_search', arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }

    const toolText = toolResult.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    const reply = `SearXNG round trip complete: ${toolText}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 6 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'searxng-mock-llm'
export const inject = ['llm']

/** Register the keyless `searxng-mock` adapter. */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['searxng-mock'], new SearxngMockAdapter())
  ctx.on('agent/request', async ({ step }, next) => {
    const config = await next()
    return step === 2 ? { ...config, reasoningEffort: OFF } : config
  })
}
