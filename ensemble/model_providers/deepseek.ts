// @ts-nocheck
/**
 * DeepSeek model provider for the MAGI system.
 *
 * We extend OpenAIChat as DeepSeek is a drop in replacement.
 * This version includes workarounds for deepseek-reasoner limitations:
 * - Removes unsupported parameters.
 * - Transforms tool calls/results into text messages for the history.
 * - Consolidates system messages at the start.
 * - Injects tool definitions and instructions for MULTIPLE simulated tool calls.
 * - Includes fix for merging consecutive user messages.
 * - Removed potentially problematic final message swap logic.
 */

import { OpenAIChat } from './openai_chat.js'; // Adjust path as needed
import OpenAI from 'openai';

// Define a type alias for message parameters for clarity
type MessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;
// Define type for standard OpenAI tool format
type OpenAITool = OpenAI.Chat.Completions.ChatCompletionTool;

/**
 * Helper function to generate a textual description of tools for the system prompt.
 * @param tools Array of ToolFunction objects.
 * @returns A string describing the available tools and instructions for simulated calls.
 */
function formatToolsForPrompt(tools: OpenAITool[]): string {
    if (!tools || tools.length === 0) {
        return 'No tools are available for use.';
    }

    const toolDescriptions = tools
        .map(tool => {
            if (tool.type !== 'function' || !tool.function) {
                return `  - Unknown tool type: ${tool.type}`;
            }
            const func = tool.function;
            // Safely access parameters and properties
            const parameters =
                func.parameters && typeof func.parameters === 'object'
                    ? func.parameters
                    : {};
            const properties =
                'properties' in parameters ? parameters.properties : {};
            const requiredParams =
                'required' in parameters && Array.isArray(parameters.required)
                    ? parameters.required
                    : [];

            const paramsJson = JSON.stringify(properties, null, 2);

            return `  - Name: ${func.name}\n    Description: ${func.description || 'No description'}\n    Parameters (JSON Schema): ${paramsJson}\n    Required Parameters: ${requiredParams.join(', ') || 'None'}`;
        })
        .join('\n\n');

    // Instructions updated for MULTIPLE tool calls using TOOL_CALLS and a JSON array
    // Added a note about fixed/consistent tool call IDs
    return `You have the following tools available:\n${toolDescriptions}\n\nTo use one or more tools, output the following JSON structure containing an ARRAY of tool calls on a new line *at the very end* of your response, and *only* if you intend to call tool(s). Ensure the arguments value in each call is a JSON *string*: \n\`\`\`json\nTOOL_CALLS: [ {"id": "call_001", "type": "function", "function": {"name": "function_name_1", "arguments": "{\\"arg1\\": \\"value1\\"}"}}, {"id": "call_002", "type": "function", "function": {"name": "function_name_2", "arguments": "{\\"argA\\": true, \\"argB\\": 123}"}} ]\n\`\`\`\nReplace \`function_name\` and arguments accordingly for each tool call you want to make. Put all desired calls in the array. IMPORTANT: Always include an 'id' field with a unique string for each call. Do not add any text after the TOOL_CALLS line. If you are not calling any tools, respond normally without the TOOL_CALLS structure.`;
}

/**
 * DeepSeek model provider implementation
 */
export class DeepSeekProvider extends OpenAIChat {
    constructor() {
        // Call the parent constructor with provider name, API key, and base URL
        super(
            'deepseek',
            process.env.DEEPSEEK_API_KEY,
            'https://api.deepseek.com/v1'
        );
    }

    /**
     * Prepares the request parameters specifically for DeepSeek models.
     * Adjusts parameters based on the model, especially for 'deepseek-reasoner'.
     * @param requestParams The original request parameters.
     * @returns The modified request parameters suitable for DeepSeek.
     */
    prepareParameters(
        requestParams: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming
    ): OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming {
        // Check if the specific 'deepseek-reasoner' model is being used
        if (requestParams.model === 'deepseek-reasoner') {
            const originalTools: OpenAITool[] = requestParams.tools ?? [];

            // --- Parameter Adjustments ---
            requestParams.max_tokens = 8000; // Set a reasonable default if needed
            delete requestParams.tools;
            delete requestParams.response_format;
            delete requestParams.logprobs;
            delete requestParams.top_logprobs;
            if ('tool_choice' in requestParams) {
                delete requestParams.tool_choice;
            }

            let messages: MessageParam[] = [...requestParams.messages];

            // Add in tool descriptions and instructions
            const toolInfoForPrompt = formatToolsForPrompt(originalTools);
            if (toolInfoForPrompt) {
                messages.push({ role: 'system', content: toolInfoForPrompt });
            }

            // Ensure the content of messages are strings
            messages = messages.map(originalMessage => {
                // Create a shallow copy to avoid modifying the original request params directly if needed elsewhere
                let message: MessageParam = { ...originalMessage };

                // Transform 'assistant' message with tool calls
                if (message.role === 'assistant' && message.tool_calls) {
                    const calls = message.tool_calls
                        .map(toolCall => {
                            if (toolCall.type === 'function') {
                                // Ensure arguments are stringified if they aren't already
                                const args =
                                    typeof toolCall.function.arguments ===
                                    'string'
                                        ? toolCall.function.arguments
                                        : JSON.stringify(
                                              toolCall.function.arguments
                                          );
                                return `Called function '${toolCall.function.name}' with arguments: ${args}`;
                            }
                            return `(Unsupported tool call type: ${toolCall.type})`;
                        })
                        .join('\n');
                    // Replace the original assistant message with a text description of the calls
                    message = {
                        role: 'assistant',
                        content: `[Previous Action] ${calls}`,
                    };
                }
                // Transform 'tool' message into a 'user' message
                else if (message.role === 'tool') {
                    const contentString =
                        typeof message.content === 'string'
                            ? message.content
                            : JSON.stringify(message.content);
                    const toolCallIdInfo = message.tool_call_id
                        ? ` for call ID ${message.tool_call_id}`
                        : '';
                    // Replace the original tool message with a user message containing the result
                    message = {
                        role: 'user',
                        content: `[Tool Result${toolCallIdInfo}] ${contentString}`,
                    };
                }

                // Ensure the content is a string
                if (typeof message.content !== 'string') {
                    message.content = JSON.stringify(message.content);
                }

                return message;
            });

            // Ensure the last message is 'user'
            if (
                messages.length === 0 ||
                messages[messages.length - 1].role !== 'user'
            ) {
                // Handle cases where the list is empty or ends with non-user
                const aiName = process.env.AI_NAME || 'Magi'; // Use environment variable or default
                messages.push({
                    role: 'user',
                    content: `${aiName} thoughts: Let me think through this step by step...`,
                });
            }

            // Extract system messages
            const systemContents: string[] = [];
            let finalMessages: MessageParam[] = [];
            messages.forEach(msg => {
                if (msg.role === 'system') {
                    // Collect content from system messages
                    if (msg.content && typeof msg.content === 'string') {
                        systemContents.push(msg.content);
                    } else if (msg.content) {
                        try {
                            systemContents.push(JSON.stringify(msg.content));
                        } catch (e) {
                            console.error(
                                `(${this.provider}) Failed to stringify system message content:`,
                                e
                            );
                        }
                    }
                } else {
                    // Collect all non-system messages
                    finalMessages.push(msg);
                }
            });

            // Merge consecutive messages of the same role
            finalMessages = finalMessages.reduce(
                (acc: MessageParam[], currentMessage) => {
                    const lastMessage =
                        acc.length > 0 ? acc[acc.length - 1] : null;

                    // Check if the last message exists and has the same role as the current one.
                    if (
                        lastMessage &&
                        lastMessage.role === currentMessage.role
                    ) {
                        lastMessage.content = `${lastMessage.content ?? ''}\n\n${currentMessage.content ?? ''}`;
                    } else {
                        acc.push({ ...currentMessage });
                    }

                    return acc;
                },
                []
            );

            if (systemContents.length > 0) {
                // Add the consolidated system message at the start
                finalMessages.unshift({
                    role: 'system',
                    content: systemContents.join('\n\n'),
                });
            }

            // Assign the processed messages back to the request parameters
            requestParams.messages = finalMessages;
        } else {
            // If not 'deepseek-reasoner', delegate to the parent class's preparation
            return super.prepareParameters(requestParams);
        }
        // Return the modified parameters
        return requestParams;
    }
}

// Export a singleton instance of the provider
export const deepSeekProvider = new DeepSeekProvider();
