/**
 * Test model provider for the MAGI system.
 *
 * This module provides a mock implementation of the ModelProvider interface
 * for testing purposes. It allows simulating different LLM behaviors, error conditions,
 * and response patterns without needing real API calls.
 */

import {
    ModelProvider,
    ResponseInput,
    StreamingEvent,
    ToolCall,
    ResponseInputItem,
} from './types.js';
import { v4 as uuidv4 } from 'uuid';
import { Agent } from '../utils/agent.js';
import { costTracker } from '../utils/cost_tracker.js';

/**
 * Configuration for the test provider behavior
 */
export interface TestProviderConfig {
    // Delay between chunks in milliseconds for simulating real-time streaming
    streamingDelay?: number;

    // Whether to deliberately cause an error during streaming
    shouldError?: boolean;

    // Error message to return when shouldError is true
    errorMessage?: string;

    // Whether to simulate a rate limit error (HTTP 429)
    simulateRateLimit?: boolean;

    // Fixed text to respond with (overrides generated response)
    fixedResponse?: string | undefined;

    // Fixed thinking to respond with (for reasoning agent simulation)
    fixedThinking?: string | undefined;

    // Whether to simulate a tool call
    simulateToolCall?: boolean;

    // Tool name to call when simulateToolCall is true
    toolName?: string;

    // Tool arguments to use when simulateToolCall is true
    toolArguments?: Record<string, any>;

    // Token usage for cost tracking
    tokenUsage?: {
        inputTokens: number;
        outputTokens: number;
    };

    // How many characters to emit per chunk when streaming
    chunkSize?: number;
}

// Global test provider configuration that can be modified for testing
export const testProviderConfig: TestProviderConfig = {
    streamingDelay: 50,
    shouldError: false,
    errorMessage: 'Simulated error from test provider',
    simulateRateLimit: false,
    fixedResponse: undefined,
    fixedThinking: undefined,
    simulateToolCall: false,
    toolName: 'web_search',
    toolArguments: { query: 'test query' },
    tokenUsage: {
        inputTokens: 100,
        outputTokens: 200,
    },
    chunkSize: 5,
};

/**
 * Resets the test provider configuration to defaults
 */
export function resetTestProviderConfig() {
    testProviderConfig.streamingDelay = 50;
    testProviderConfig.shouldError = false;
    testProviderConfig.errorMessage = 'Simulated error from test provider';
    testProviderConfig.simulateRateLimit = false;
    testProviderConfig.fixedResponse = undefined;
    testProviderConfig.fixedThinking = undefined;
    testProviderConfig.simulateToolCall = false;
    testProviderConfig.toolName = 'web_search';
    testProviderConfig.toolArguments = { query: 'test query' };
    testProviderConfig.tokenUsage = {
        inputTokens: 100,
        outputTokens: 200,
    };
    testProviderConfig.chunkSize = 5;
}

/**
 * Helper to create a delay
 */
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * TestProvider implementation of the ModelProvider interface
 */
export class TestProvider implements ModelProvider {
    private config: TestProviderConfig;

    constructor(config: TestProviderConfig = testProviderConfig) {
        this.config = config;
    }

    /**
     * Simulates a streaming response from a model
     */
    async *createResponseStream(
        model: string,
        messages: ResponseInput,
        agent: Agent
    ): AsyncGenerator<StreamingEvent> {
        console.log(
            `[TestProvider] Creating response stream for model: ${model}`
        );

        // Record the input messages for cost tracking
        const lastUserMessage = messages
            .filter(m => 'role' in m && m.role === 'user')
            .pop() as ResponseInputItem;

        const userMessageContent =
            lastUserMessage && 'content' in lastUserMessage
                ? typeof lastUserMessage.content === 'string'
                    ? lastUserMessage.content
                    : JSON.stringify(lastUserMessage.content)
                : '';

        const inputTokenCount =
            this.config.tokenUsage?.inputTokens ||
            Math.max(50, Math.ceil(userMessageContent.length / 4));

        // Generate a response based on config
        let response: string;

        // Check for rate limit simulation
        if (this.config.simulateRateLimit) {
            const rateLimitError =
                '429 Too Many Requests: The server is currently processing too many requests. Please try again later.';
            yield {
                type: 'error',
                error: rateLimitError,
            };
            return; // End the generator
        }

        // Check for error simulation
        if (this.config.shouldError) {
            yield {
                type: 'error',
                error:
                    this.config.errorMessage ||
                    'Simulated error from test provider',
            };
            return; // End the generator
        }

        // Generate a response based on the user's message or use fixed response
        if (this.config.fixedResponse) {
            response = this.config.fixedResponse;
        } else {
            // Generic response based on input
            response = this.generateResponse(userMessageContent);
        }

        // Generate a message ID for tracking this response
        const messageId = uuidv4();

        // First, emit a message_start event
        yield {
            type: 'message_start',
            message_id: messageId,
            content: '',
            agent: agent?.export(),
        };

        // If there's thinking content, emit it first
        if (this.config.fixedThinking) {
            yield {
                type: 'message_delta',
                message_id: messageId,
                content: '',
                thinking_content: this.config.fixedThinking,
                thinking_signature: '(Simulated thinking)',
            };

            await sleep(this.config.streamingDelay || 50);
        }

        // Simulate a tool call if configured
        if (this.config.simulateToolCall && agent) {
            const currentTools = agent.getTools();
            if (currentTools) {
                const toolArray = await currentTools;
                if (toolArray.length > 0) {
                    // Use execute_command as a well-known tool
                    const availableTool = toolArray.find(tool =>
                        this.config.toolName
                            ? tool.definition.function.name ===
                              this.config.toolName
                            : true
                    );

                    if (availableTool) {
                        const toolCall: ToolCall = {
                            id: uuidv4(),
                            type: 'function',
                            function: {
                                name: availableTool.definition.function.name,
                                arguments: JSON.stringify(
                                    this.config.toolArguments || {
                                        query: userMessageContent.slice(0, 50),
                                    }
                                ),
                            },
                        };

                        // Emit tool call event
                        yield {
                            type: 'tool_start',
                            tool_calls: [toolCall],
                            agent: agent?.export(),
                        };

                        // Let the tool processing happen elsewhere - we don't emit a result
                        await sleep(this.config.streamingDelay || 50);

                        // Update the response to mention the tool call
                        response = `I've used the ${toolCall.function.name} tool to help answer your question.\n\n${response}`;
                    }
                }
            }
        }

        // Stream the response in chunks
        const chunkSize = this.config.chunkSize || 5;
        let position = 0;

        while (position < response.length) {
            const chunk = response.slice(position, position + chunkSize);
            position += chunkSize;

            yield {
                type: 'message_delta',
                message_id: messageId,
                content: chunk,
                order: position / chunkSize,
                agent: agent?.export(),
            };

            // Simulate network delay
            await sleep(this.config.streamingDelay || 50);
        }

        // Final message_complete event
        yield {
            type: 'message_complete',
            message_id: messageId,
            content: response,
            agent: agent?.export(),
        };

        // Track token usage for cost calculation
        costTracker.addUsage({
            model,
            input_tokens: inputTokenCount,
            output_tokens:
                this.config.tokenUsage?.outputTokens ||
                Math.ceil(response.length / 4),
        });
    }

    /**
     * Generates a simple response based on input
     */
    private generateResponse(input: string): string {
        const lowercaseInput = input.toLowerCase();

        // Generate different responses based on input keywords
        if (lowercaseInput.includes('hello') || lowercaseInput.includes('hi')) {
            return "Hello! I'm a test AI model. How can I help you today?";
        } else if (lowercaseInput.includes('help')) {
            return "I'm here to help! What do you need assistance with?";
        } else if (
            lowercaseInput.includes('error') ||
            lowercaseInput.includes('problem')
        ) {
            return "I understand you're experiencing an issue. Let me help troubleshoot the problem.";
        } else if (lowercaseInput.includes('test')) {
            return 'This is a test response. The test provider is working correctly!';
        } else if (lowercaseInput.includes('?')) {
            return "That's an interesting question. As a test model, I'm designed to provide simulated responses for testing purposes.";
        } else {
            return `I've received your message: "${input.slice(0, 50)}${input.length > 50 ? '...' : ''}". This is a simulated response from the test provider.`;
        }
    }
}

// Export an instance of the provider
export const testProvider = new TestProvider();
