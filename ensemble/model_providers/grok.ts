// @ts-nocheck
/**
 * Grok model provider for the MAGI system.
 *
 * We extend OpenAIChat as Grok is a drop in replacement
 */

import { OpenAIChat } from './openai_chat.js';
import OpenAI from 'openai';

/**
 * Grok model provider implementation
 */
export class GrokProvider extends OpenAIChat {
    constructor() {
        super('xai', process.env.XAI_API_KEY, 'https://api.x.ai/v1');
    }

    prepareParameters(
        requestParams: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming
    ): OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming {
        if (Array.isArray(requestParams.tools)) {
            const index = requestParams.tools.findIndex(
                t =>
                    t.type === 'function' &&
                    (t as any).function?.name === 'grok_web_search'
            );
            if (index !== -1) {
                requestParams.tools.splice(index, 1);
                (requestParams as any).search_parameters = {
                    mode: 'on',
                    return_citations: true,
                };
            }
        }
        return super.prepareParameters(requestParams);
    }
}

// Export an instance of the provider
export const grokProvider = new GrokProvider();
