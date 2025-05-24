/**
 * OpenRouter model provider for the MAGI system.
 */

import { OpenAIChat } from './openai_chat.js';

/**
 * OpenRouter model provider implementation
 */
export class OpenRouterProvider extends OpenAIChat {
    constructor() {
        super(
            'openrouter',
            process.env.OPENROUTER_API_KEY,
            'https://openrouter.ai/api/v1',
            {
                'User-Agent': 'magi',
                'HTTP-Referer': 'https://withmagi.com/',
                'X-Title': 'magi',
            },
            {
                provider: {
                    require_parameters: true,
                    sort: 'throughput',
                    ignore: ['Novita'], // Fails frequently with Qwen tool calling
                },
            }
        );
    }
}

/**
 * A singleton instance of OpenRouterProvider for use in import statements
 */
export const openRouterProvider = new OpenRouterProvider();
