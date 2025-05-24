// @ts-nocheck
/**
 * Claude model provider for the MAGI system.
 *
 * This module provides an implementation of the ModelProvider interface
 * for Anthropic's Claude models and handles streaming responses.
 */

import Anthropic from '@anthropic-ai/sdk';
import { v4 as uuidv4 } from 'uuid';

/**
 * Format web search results into a readable text format
 */
function formatWebSearchResults(results: any[]): string {
    if (!Array.isArray(results)) return '';
    return results
        .filter(r => r.type === 'web_search_result')
        .map((r, i) => `${i + 1}. ${r.title || 'Untitled'} – ${r.url}`)
        .join('\n');
}

/**
 * Citation tracking for footnotes
 */
interface CitationTracker {
    citations: Map<string, { title: string; url: string; citedText: string }>;
    lastIndex: number;
}

/**
 * Create a new citation tracker
 */
function createCitationTracker(): CitationTracker {
    return {
        citations: new Map(),
        lastIndex: 0,
    };
}

/**
 * Format citation as a footnote and return a reference marker
 */
function formatCitation(
    tracker: CitationTracker,
    citation: {
        title: string;
        url: string;
        cited_text: string;
        encrypted_index?: string;
    }
): string {
    // Use URL as key to deduplicate citations
    const url = citation.url;
    let index: number;

    if (tracker.citations.has(url)) {
        // Find the index of this citation in the tracker (1-based)
        const entries = Array.from(tracker.citations.entries());
        index = entries.findIndex(([k]) => k === url) + 1;
    } else {
        // Create new citation
        tracker.lastIndex++;
        index = tracker.lastIndex;
        tracker.citations.set(url, {
            title: citation.title,
            url: citation.url,
            citedText: citation.cited_text,
        });
    }

    // Return the reference marker
    return ` [${index}]`;
}

/**
 * Generate formatted footnotes from citation tracker
 */
function generateFootnotes(tracker: CitationTracker): string {
    if (tracker.citations.size === 0) return '';

    const footnotes = Array.from(tracker.citations.values())
        .map((citation, i) => `[${i + 1}] ${citation.title} – ${citation.url}`)
        .join('\n');

    return '\n\nReferences:\n' + footnotes;
}
import {
    ModelProvider,
    ToolFunction,
    ModelSettings,
    StreamingEvent,
    ToolCall,
    ResponseInput,
    ResponseInputItem,
    ResponseInputMessage,
    ResponseThinkingMessage,
    ResponseOutputMessage,
    EnsembleAgent,
} from '../types.js';
import { costTracker } from '../utils/cost_tracker.js';
import {
    log_llm_error,
    log_llm_request,
    log_llm_response,
} from '../utils/llm_logger.js';
import { isPaused } from '../utils/communication.js';
import { ModelClassID } from './model_data.js';
import {
    extractBase64Image,
    resizeAndTruncateForClaude,
} from '../utils/image_utils.js';
import { convertImageToTextIfNeeded } from '../utils/image_to_text.js';
import {
    DeltaBuffer,
    bufferDelta,
    flushBufferedDeltas,
} from '../utils/delta_buffer.js';

// Convert our tool definition to Claude's format
function convertToClaudeTools(tools: ToolFunction[]): any[] {
    return tools.map(tool => {
        // Special handling for web search tool
        if (tool.definition.function.name === 'claude_web_search') {
            return {
                type: 'web_search_20250305',
                name: 'web_search',
            };
        }

        // Standard tool handling for other tools
        return {
            // Directly map the properties to the top level
            name: tool.definition.function.name,
            description: tool.definition.function.description,
            // Map 'parameters' from your definition to 'input_schema' for Claude
            input_schema: tool.definition.function.parameters,
        };
    });
}

// Assuming ResponseInputItem is your internal message structure type
// Assuming ClaudeMessage is the structure Anthropic expects (or null)
type ClaudeMessage = {
    role: 'user' | 'assistant' | 'system';
    content: any;
} | null; // Simplified type

/**
 * Helper function to determine image media type from base64 data
 */
function getImageMediaType(imageData: string): string {
    if (imageData.includes('data:image/jpeg')) return 'image/jpeg';
    if (imageData.includes('data:image/png')) return 'image/png';
    if (imageData.includes('data:image/gif')) return 'image/gif';
    if (imageData.includes('data:image/webp')) return 'image/webp';
    // Default to jpeg if no specific type found
    return 'image/jpeg';
}

/**
 * Helper function to clean base64 data by removing the prefix
 */
function cleanBase64Data(imageData: string): string {
    return imageData.replace(/^data:image\/[a-z]+;base64,/, '');
}

/**
 * Converts a custom ResponseInputItem into Anthropic Claude's message format.
 * Handles text messages, tool use requests (function calls), and tool results (function outputs).
 *
 * @param role The original role associated with the message ('user', 'assistant', 'system').
 * @param content The text content, primarily for non-tool messages.
 * @param msg The detailed message object (ResponseInputItem).
 * @returns A Claude message object or null if conversion is not applicable (e.g., system message, empty content).
 */
async function convertToClaudeMessage(
    role: string,
    content: string,
    msg: ResponseInputItem,
    result?: any[]
): Promise<ClaudeMessage> {
    if (!msg) return null;

    // --- Handle Tool Use (Function Call) ---
    if (msg.type === 'function_call') {
        let inputArgs: Record<string, unknown> = {};
        try {
            // Claude expects 'input' as an object
            inputArgs = JSON.parse(msg.arguments || '{}');
        } catch (e) {
            console.error(
                `Error parsing function call arguments for ${msg.name}: ${msg.arguments}`,
                e
            );
            return null;
        }

        const toolUseBlock = {
            type: 'tool_use',
            id: msg.call_id, // Use the consistent ID field
            name: msg.name,
            input: inputArgs,
        };

        return { role: 'assistant', content: [toolUseBlock] };
    } else if (msg.type === 'function_call_output') {
        // Check if output contains a base64 image
        if (typeof msg.output === 'string') {
            const extracted = extractBase64Image(msg.output);

            if (extracted.found && extracted.image_id !== null) {
                // Use the image ID from the extracted result
                const image_id = extracted.image_id;

                try {
                    // Get the first image data and resize/truncate for Claude
                    const originalImageData = extracted.images[image_id];
                    const processedImageData =
                        await resizeAndTruncateForClaude(originalImageData);
                    const mediaType = getImageMediaType(processedImageData);
                    const cleanedImageData =
                        cleanBase64Data(processedImageData);

                    const toolResultBlock = {
                        type: 'tool_result',
                        tool_use_id: msg.call_id,
                        content: extracted.replaceContent.trim() || '', // Text with image placeholders
                        ...(msg.status === 'incomplete'
                            ? { is_error: true }
                            : {}),
                    };

                    // Content blocks for Claude message
                    const contentBlocks = [
                        toolResultBlock,
                        // Add image after the tool result
                        {
                            type: 'image',
                            source: {
                                type: 'base64',
                                media_type: mediaType,
                                data: cleanedImageData,
                            },
                        },
                        // Add a text description for the image
                        {
                            type: 'text',
                            text: `This is [image #${image_id}] from the function call output of ${msg.name}`,
                        },
                    ];

                    return { role: 'user', content: contentBlocks };
                } catch (error) {
                    console.error(
                        'Error processing image in function call output:',
                        error
                    );
                    // If there's an error, continue with just the text content
                }
            }
        }

        // Standard tool result handling (no image)
        const toolResultBlock = {
            type: 'tool_result',
            tool_use_id: msg.call_id, // ID must match the corresponding tool_use block
            content: msg.output || '', // Default to empty string if output is missing
            ...(msg.status === 'incomplete' ? { is_error: true } : {}),
        };

        // Anthropic expects role: 'user' for tool_result
        return { role: 'user', content: [toolResultBlock] };
    } else if (msg.type === 'thinking') {
        if (!content) {
            return null; // Can't process thinking without content
        }

        if ('signature' in msg && msg.signature) {
            // Return a thinking message with the content and signature
            return {
                role: 'assistant',
                content: [
                    {
                        type: 'thinking',
                        thinking: content.trim(),
                        signature: msg.signature,
                    },
                ],
            };
        }
        return { role: 'assistant', content: 'Thinking: ' + content.trim() };
    } else {
        // Skip messages with no actual text content
        if (!content) {
            return null; // Skip messages with no text content
        }

        let messageRole: 'user' | 'system' | 'assistant' =
            role === 'assistant'
                ? 'assistant'
                : (role === 'system' || role === 'developer') && !result?.length
                  ? 'system'
                  : 'user';

        if (messageRole !== 'system') {
            // Check if content contains a base64 image
            const extracted = extractBase64Image(content);
            if (extracted.found && extracted.image_id !== null) {
                messageRole = 'user'; // System messages are not supported for images

                try {
                    // Get the first image and resize/truncate for Claude
                    const image_id = extracted.image_id;
                    const originalImageData = extracted.images[image_id];
                    const processedImageData =
                        await resizeAndTruncateForClaude(originalImageData);
                    const mediaType = getImageMediaType(processedImageData);
                    const cleanedImageData =
                        cleanBase64Data(processedImageData);

                    // Build content array with text and image
                    const contentBlocks = [];

                    // Add image block
                    contentBlocks.push({
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: mediaType,
                            data: cleanedImageData,
                        },
                    });

                    // Add text block with text (now using replaceContent)
                    if (extracted.replaceContent.trim()) {
                        contentBlocks.push({
                            type: 'text',
                            text: extracted.replaceContent.trim(),
                        });
                    }

                    return {
                        role: messageRole,
                        content: contentBlocks,
                    };
                } catch (error) {
                    console.error('Error processing image in message:', error);
                    // If there's an error, continue with just the text content
                }
            }
        }

        // Standard text message handling (no image)
        return {
            role: messageRole,
            content: content.trim(),
        };
    }
}

/**
 * Claude model provider implementation
 */
export class ClaudeProvider implements ModelProvider {
    private client: Anthropic;

    constructor(apiKey?: string) {
        this.client = new Anthropic({
            apiKey: apiKey || process.env.ANTHROPIC_API_KEY,
        });

        if (!this.client) {
            throw new Error(
                'Failed to initialize Claude client. Make sure ANTHROPIC_API_KEY is set.'
            );
        }
    }

    /**
     * Preprocess messages to convert images to text descriptions for models
     * that don't support image input
     *
     * @param messages - The original messages
     * @param modelId - The model ID
     * @returns Processed messages with images converted to text when needed
     */
    private async preprocessMessagesForImageSupport(
        messages: ResponseInput,
        modelId: string
    ): Promise<ResponseInput> {
        // Clone the messages
        const processedMessages = [...messages];

        // Process each message
        for (let i = 0; i < processedMessages.length; i++) {
            const msg = processedMessages[i];

            // Check if this is a message type that has a content property (using type guard)
            if (!this.isMessageWithStringContent(msg)) {
                continue;
            }

            // Handle content based on its type
            if (typeof msg.content === 'string') {
                // Direct string content - check if it contains an image
                const extracted = extractBase64Image(msg.content as string);
                if (extracted.found && extracted.image_id !== null) {
                    try {
                        // Get the first image
                        const image_id = extracted.image_id;
                        const imageData = extracted.images[image_id];

                        // Convert image to text if needed
                        const processedImageData =
                            await convertImageToTextIfNeeded(
                                imageData,
                                modelId
                            );

                        // If the image was converted to text (not still an image data URL)
                        if (!processedImageData.startsWith('data:image/')) {
                            // Create new content with the text description
                            const newContent = extracted.replaceContent.trim()
                                ? extracted.replaceContent.trim() +
                                  ' ' +
                                  processedImageData
                                : processedImageData;

                            // Replace the image in the original message with the text description (preserving message type)
                            processedMessages[i] = {
                                ...msg,
                                content: newContent,
                            } as ResponseInputItem;

                            console.log(
                                `Converted image to text description for model ${modelId}`
                            );
                        }
                    } catch (error) {
                        console.error('Error converting image to text:', error);
                    }
                }
            } else if (Array.isArray(msg.content)) {
                // Array content - process each text item that might contain an image
                let hasChanges = false;
                const newContentItems = [...msg.content];

                for (let j = 0; j < newContentItems.length; j++) {
                    const item = newContentItems[j];
                    if (
                        item.type === 'input_text' &&
                        typeof item.text === 'string'
                    ) {
                        const extracted = extractBase64Image(item.text);
                        if (extracted.found && extracted.image_id !== null) {
                            try {
                                // Get the first image
                                const image_id = extracted.image_id;
                                const imageData = extracted.images[image_id];

                                // Convert image to text if needed
                                const processedImageData =
                                    await convertImageToTextIfNeeded(
                                        imageData,
                                        modelId
                                    );

                                // If the image was converted to text (not still an image data URL)
                                if (
                                    !processedImageData.startsWith(
                                        'data:image/'
                                    )
                                ) {
                                    // Create new content with the text description
                                    const newText =
                                        extracted.replaceContent.trim()
                                            ? extracted.replaceContent.trim() +
                                              ' ' +
                                              processedImageData
                                            : processedImageData;

                                    // Update this item
                                    newContentItems[j] = {
                                        ...item,
                                        text: newText,
                                    };
                                    hasChanges = true;

                                    console.log(
                                        `Converted image to text description in array content for model ${modelId}`
                                    );
                                }
                            } catch (error) {
                                console.error(
                                    'Error converting image to text in array content:',
                                    error
                                );
                            }
                        }
                    }
                }

                // Only update the message if we made changes
                if (hasChanges) {
                    processedMessages[i] = {
                        ...msg,
                        content: newContentItems,
                    } as ResponseInputItem;
                }
            }
        }

        return processedMessages;
    }

    /**
     * Combined preprocessing (image conversion) and Claude-specific mapping in a single pass.
     * This merges the responsibilities of `preprocessMessagesForImageSupport`,
     * `convertHistoryFormat`, and `convertToClaudeMessage` to avoid multiple
     * iterations over the message history.
     *
     * @param messages The original conversation history.
     * @param modelId  The Claude model identifier (used to decide image handling).
     * @returns Array of Claude-ready messages.
     */
    private async prepareClaudeMessages(
        messages: ResponseInput,
        modelId: string
    ): Promise<ClaudeMessage[]> {
        const result: ClaudeMessage[] = [];

        for (const originalMsg of messages) {
            let msg: ResponseInputItem = originalMsg;

            /* ---------- Inline image preprocessing (from preprocessMessagesForImageSupport) ---------- */
            if (this.isMessageWithStringContent(msg)) {
                // --- String content ---
                if (typeof msg.content === 'string') {
                    const extracted = extractBase64Image(msg.content as string);
                    if (extracted.found && extracted.image_id !== null) {
                        try {
                            const image_id = extracted.image_id;
                            const imageData = extracted.images[image_id];
                            const processedImageData =
                                await convertImageToTextIfNeeded(
                                    imageData,
                                    modelId
                                );

                            if (
                                processedImageData &&
                                !processedImageData.startsWith('data:image/')
                            ) {
                                const newContent =
                                    extracted.replaceContent.trim()
                                        ? extracted.replaceContent.trim() +
                                          ' ' +
                                          processedImageData
                                        : processedImageData;

                                msg = {
                                    ...msg,
                                    content: newContent,
                                } as ResponseInputItem;
                            }
                        } catch (error) {
                            console.error(
                                'Error converting image to text:',
                                error
                            );
                        }
                    }
                }
                // --- Array content ---
                else if (Array.isArray(msg.content)) {
                    let hasChanges = false;
                    const newContentItems = [...msg.content];

                    for (let j = 0; j < newContentItems.length; j++) {
                        const item = newContentItems[j];
                        if (
                            item.type === 'input_text' &&
                            typeof item.text === 'string'
                        ) {
                            const extracted = extractBase64Image(item.text);
                            if (
                                extracted.found &&
                                extracted.image_id !== null
                            ) {
                                try {
                                    const image_id = extracted.image_id;
                                    const imageData =
                                        extracted.images[image_id];
                                    const processedImageData =
                                        await convertImageToTextIfNeeded(
                                            imageData,
                                            modelId
                                        );

                                    if (
                                        processedImageData &&
                                        !processedImageData.startsWith(
                                            'data:image/'
                                        )
                                    ) {
                                        const newText =
                                            extracted.replaceContent.trim()
                                                ? extracted.replaceContent.trim() +
                                                  ' ' +
                                                  processedImageData
                                                : processedImageData;

                                        newContentItems[j] = {
                                            ...item,
                                            text: newText,
                                        };
                                        hasChanges = true;
                                    }
                                } catch (error) {
                                    console.error(
                                        'Error converting image to text in array content:',
                                        error
                                    );
                                }
                            }
                        }
                    }

                    if (hasChanges) {
                        msg = {
                            ...msg,
                            content: newContentItems,
                        } as ResponseInputItem;
                    }
                }
            }
            /* ---------- End image preprocessing ---------- */

            /* ---------- Build Claude message (logic similar to convertHistoryFormat + convertToClaudeMessage) ---------- */
            const role =
                'role' in msg && msg.role !== 'developer' ? msg.role : 'system';

            let content = '';
            if ('content' in msg) {
                if (typeof msg.content === 'string') {
                    content = msg.content;
                } else if (
                    (msg.content as any).text &&
                    typeof (msg.content as any).text === 'string'
                ) {
                    content = (msg.content as any).text;
                }
            }

            const structuredMsg = await convertToClaudeMessage(
                role,
                content,
                msg,
                result
            );
            if (structuredMsg) {
                result.push(structuredMsg);
            }
            /* ---------- End Claude message build ---------- */
        }

        return result;
    }

    /**
     * Type guard to check if a message has content property with image data
     */
    private isMessageWithStringContent(
        msg: ResponseInputItem
    ): msg is
        | ResponseInputMessage
        | ResponseThinkingMessage
        | ResponseOutputMessage {
        if (!('content' in msg)) return false;
        if (!msg.content) return false;
        if (
            msg.type &&
            ['function_call', 'function_call_output'].includes(msg.type)
        )
            return false;

        // Handle both string content and array content
        if (typeof msg.content === 'string') {
            return true;
        } else if (Array.isArray(msg.content)) {
            // For array content, check if any of the items contain image data
            // We're only looking for text content for now, as that could contain base64 images
            return msg.content.some(
                item =>
                    item.type === 'input_text' && typeof item.text === 'string'
            );
        }

        return false;
    }

    /**
     * Create a streaming completion using Claude's API
     */
    async *createResponseStream(
        model: string,
        messages: ResponseInput,
        agent: EnsembleAgent
    ): AsyncGenerator<StreamingEvent> {
        // --- Usage Accumulators ---
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let totalCacheCreationInputTokens = 0;
        let totalCacheReadInputTokens = 0;
        let streamCompletedSuccessfully = false; // Flag to track successful stream completion
        let messageCompleteYielded = false; // Flag to track if message_complete was yielded
        let requestId: string;

        try {
            const tools: ToolFunction[] | undefined = agent
                ? await agent.getTools()
                : [];
            const settings: ModelSettings | undefined = agent?.modelSettings;
            const modelClass: ModelClassID | undefined = agent?.modelClass;

            let thinking = undefined;
            let max_tokens = settings?.max_tokens || 64000; // Default max tokens if not specified
            switch (modelClass) {
                case 'monologue':
                case 'reasoning':
                case 'code':
                    if (model === 'claude-3-7-sonnet-latest') {
                        // Extended thinking
                        thinking = {
                            type: 'enabled',
                            budget_tokens: 16000,
                        };
                        max_tokens = Math.min(max_tokens, 64000);
                    } else {
                        max_tokens = Math.min(max_tokens, 8192);
                    }
                    break;
                case 'standard':
                    max_tokens = Math.min(max_tokens, 8192);
                    break;
                default:
                    max_tokens = Math.min(max_tokens, 4096); // Lower limit for other classes
            }

            if (settings?.json_schema) {
                messages.push({
                    type: 'message',
                    role: 'system',
                    content: `Your response MUST be a valid JSON object that conforms to this schema:\n${JSON.stringify(settings.json_schema, null, 2)}`,
                });
            }

            // Preprocess *and* convert messages for Claude in one pass
            const claudeMessages = await this.prepareClaudeMessages(
                messages,
                model
            );

            // Ensure content is a string. Handle cases where content might be structured differently or missing.
            const systemPrompt = claudeMessages.reduce((acc, msg): string => {
                if (
                    msg.role === 'system' &&
                    msg.content &&
                    typeof msg.content === 'string'
                ) {
                    return acc + msg.content + '\n'; // Append system prompt content
                }
                return acc;
            }, '');

            // Format the request according to Claude API specifications
            const requestParams: any = {
                model: model,
                // Filter for only user and assistant messages for the 'messages' array
                messages: claudeMessages.filter(
                    m => m.role === 'user' || m.role === 'assistant'
                ),
                // Add system prompt string if it exists
                ...(systemPrompt ? { system: systemPrompt } : {}),
                stream: true,
                max_tokens,
                ...(thinking ? { thinking } : {}),
                ...(settings?.temperature !== undefined
                    ? { temperature: settings.temperature }
                    : {}),
            };

            // Add tools if provided, using the corrected conversion function
            if (tools && tools.length > 0) {
                requestParams.tools = convertToClaudeTools(tools); // Uses the corrected function
            }

            // --- Pre-flight Check: Ensure messages are not empty, add default if needed ---
            if (
                !requestParams.messages ||
                requestParams.messages.length === 0
            ) {
                console.warn(
                    'Claude API Warning: No user or assistant messages provided after filtering. Adding default message.'
                );
                // Add the default user message
                requestParams.messages = [
                    {
                        role: 'user',
                        content: "Let's think this through step by step.",
                    },
                ];
            }

            // Log the request and save the requestId for later response logging
            requestId = log_llm_request(
                agent.agent_id,
                'anthropic',
                model,
                requestParams,
                new Date()
            );

            // Track current tool call info
            let currentToolCall: any = null;
            let accumulatedSignature = '';
            let accumulatedThinking = '';
            let accumulatedContent = ''; // To collect all content for final message_complete
            const messageId = uuidv4(); // Generate a unique ID for this message
            // Track delta positions for ordered message chunks
            let deltaPosition = 0;
            const deltaBuffers = new Map<string, DeltaBuffer>();
            // Citation tracking
            const citationTracker = createCitationTracker();

            // Make the API call
            const stream = await this.client.messages.create(requestParams);

            const events: StreamingEvent[] = [];
            try {
                // @ts-expect-error - Claude's stream is AsyncIterable but TypeScript might not recognize it properly
                for await (const event of stream) {
                    events.push(event); // Store events for logs

                    // Check if the system was paused during the stream
                    if (isPaused()) {
                        console.log(
                            `[Claude] System paused during stream for model ${model}. Aborting processing.`
                        );
                        yield {
                            type: 'message_delta', // Or a specific 'stream_aborted' event
                            content: '\n⏸️ Stream paused by user.',
                            message_id: messageId, // Use the existing messageId
                            order: 999, // Ensure it appears last if needed
                        };
                        streamCompletedSuccessfully = false; // Mark as not fully completed
                        break; // Exit the loop to stop processing further chunks
                    }

                    // --- Accumulate Usage ---
                    // Check message_start for initial usage (often includes input tokens)
                    if (
                        event.type === 'message_start' &&
                        event.message?.usage
                    ) {
                        const usage = event.message.usage;
                        totalInputTokens += usage.input_tokens || 0;
                        totalOutputTokens += usage.output_tokens || 0; // Sometimes initial output tokens are here
                        totalCacheCreationInputTokens +=
                            usage.cache_creation_input_tokens || 0;
                        totalCacheReadInputTokens +=
                            usage.cache_read_input_tokens || 0;
                    }
                    // Check message_delta for incremental usage (often includes output tokens)
                    else if (event.type === 'message_delta' && event.usage) {
                        const usage = event.usage;
                        // Input tokens shouldn't change mid-stream, but check just in case
                        totalInputTokens += usage.input_tokens || 0;
                        totalOutputTokens += usage.output_tokens || 0;
                        totalCacheCreationInputTokens +=
                            usage.cache_creation_input_tokens || 0;
                        totalCacheReadInputTokens +=
                            usage.cache_read_input_tokens || 0;
                    }

                    // --- Handle Content and Tool Events ---
                    // Handle content block delta
                    if (event.type === 'content_block_delta') {
                        // Emit delta event for streaming UI updates with incrementing order
                        if (
                            event.delta.type === 'signature_delta' &&
                            event.delta.signature
                        ) {
                            accumulatedSignature += event.delta.signature;
                        } else if (
                            event.delta.type === 'thinking_delta' &&
                            event.delta.thinking
                        ) {
                            yield {
                                type: 'message_delta',
                                content: '',
                                thinking_content: event.delta.thinking,
                                message_id: messageId,
                                order: deltaPosition++,
                            };
                            accumulatedThinking += event.delta.thinking;
                        } else if (
                            event.delta.type === 'text_delta' &&
                            event.delta.text
                        ) {
                            for (const ev of bufferDelta(
                                deltaBuffers,
                                messageId,
                                event.delta.text,
                                content =>
                                    ({
                                        type: 'message_delta',
                                        content,
                                        message_id: messageId,
                                        order: deltaPosition++,
                                    }) as StreamingEvent
                            )) {
                                yield ev;
                            }
                            accumulatedContent += event.delta.text;
                        } else if (
                            event.delta.type === 'input_json_delta' &&
                            currentToolCall &&
                            event.delta.partial_json
                        ) {
                            try {
                                // Append the partial JSON string to the arguments
                                // Note: This assumes arguments are always JSON stringified.
                                // If arguments could be simple strings, this needs adjustment.
                                // We might need a more robust way to reconstruct the JSON.
                                // For now, appending might work for many cases but could break complex JSON.
                                // A safer approach might be to accumulate the partial_json and parse at the end.
                                // Let's try accumulating first.
                                if (
                                    !currentToolCall.function._partialArguments
                                ) {
                                    currentToolCall.function._partialArguments =
                                        '';
                                }
                                currentToolCall.function._partialArguments +=
                                    event.delta.partial_json;

                                // Update the main arguments field for intermediate UI updates (best effort)
                                currentToolCall.function.arguments =
                                    currentToolCall.function._partialArguments;

                                // Yielding tool_start repeatedly might be noisy; consider yielding tool_delta if needed
                                yield {
                                    type: 'tool_delta',
                                    tool_calls: [currentToolCall as ToolCall],
                                };
                            } catch (err) {
                                console.error(
                                    'Error processing tool_use delta (input_json_delta):',
                                    err,
                                    event
                                );
                            }
                        } else if (
                            event.delta.type === 'citations_delta' &&
                            event.delta.citation
                        ) {
                            // Format the citation and append a reference marker
                            const citationMarker = formatCitation(
                                citationTracker,
                                event.delta.citation
                            );

                            // Yield the citation marker
                            yield {
                                type: 'message_delta',
                                content: citationMarker,
                                message_id: messageId,
                                order: deltaPosition++,
                            };
                            accumulatedContent += citationMarker;
                        }
                    }
                    // Handle content block start for text
                    else if (
                        event.type === 'content_block_start' &&
                        event.content_block?.type === 'text'
                    ) {
                        if (event.content_block.text) {
                            for (const ev of bufferDelta(
                                deltaBuffers,
                                messageId,
                                event.content_block.text,
                                content =>
                                    ({
                                        type: 'message_delta',
                                        content,
                                        message_id: messageId,
                                        order: deltaPosition++,
                                    }) as StreamingEvent
                            )) {
                                yield ev;
                            }
                            accumulatedContent += event.content_block.text;
                        }
                    }
                    // Handle content block stop for text (less common for text deltas, but handle defensively)
                    else if (
                        event.type === 'content_block_stop' &&
                        event.content_block?.type === 'text'
                    ) {
                        // No specific action needed here usually if deltas are handled,
                        // but keep the structure in case API behavior changes.
                    }
                    // Handle web search tool results
                    else if (
                        event.type === 'content_block_start' &&
                        event.content_block?.type === 'web_search_tool_result'
                    ) {
                        if (event.content_block.content) {
                            // Format the web search results as a nicely formatted list
                            const formatted = formatWebSearchResults(
                                event.content_block.content
                            );
                            if (formatted) {
                                // Yield the formatted results
                                yield {
                                    type: 'message_delta',
                                    content:
                                        '\n\nSearch Results:\n' +
                                        formatted +
                                        '\n',
                                    message_id: messageId,
                                    order: deltaPosition++,
                                };
                                accumulatedContent +=
                                    '\n\nSearch Results:\n' + formatted + '\n';
                            }
                        }
                    }
                    // Handle tool use start
                    else if (
                        event.type === 'content_block_start' &&
                        event.content_block?.type === 'tool_use'
                    ) {
                        const toolUse = event.content_block;
                        const toolId = toolUse.id || `call_${Date.now()}`;
                        const toolName = toolUse.name;
                        const toolInput =
                            toolUse.input !== undefined ? toolUse.input : {};
                        currentToolCall = {
                            id: toolId,
                            type: 'function',
                            function: {
                                name: toolName,
                                arguments:
                                    typeof toolInput === 'string'
                                        ? toolInput
                                        : JSON.stringify(toolInput),
                            },
                        };
                    }
                    // Handle tool use stop
                    else if (
                        event.type === 'content_block_stop' &&
                        event.content_block?.type === 'tool_use' &&
                        currentToolCall
                    ) {
                        try {
                            // Finalize arguments if they were streamed partially
                            if (currentToolCall.function._partialArguments) {
                                currentToolCall.function.arguments =
                                    currentToolCall.function._partialArguments;
                                delete currentToolCall.function
                                    ._partialArguments; // Clean up temporary field
                            }
                            yield {
                                type: 'tool_start',
                                tool_calls: [currentToolCall as ToolCall],
                            };
                        } catch (err) {
                            console.error(
                                'Error finalizing tool call:',
                                err,
                                event
                            );
                        } finally {
                            // Reset currentToolCall *after* potential final processing
                            currentToolCall = null;
                        }
                    }
                    // Handle message stop
                    else if (event.type === 'message_stop') {
                        // Check for any final usage info (less common here, but possible)
                        // Note: The example payload doesn't show usage here, but the Anthropic SDK might add it.
                        if (event['amazon-bedrock-invocationMetrics']) {
                            // Check for Bedrock specific metrics if applicable
                            const metrics =
                                event['amazon-bedrock-invocationMetrics'];
                            totalInputTokens += metrics.inputTokenCount || 0;
                            totalOutputTokens += metrics.outputTokenCount || 0;
                            // Add other Bedrock metrics if needed
                        } else if (event.usage) {
                            // Check standard usage object as a fallback
                            const usage = event.usage;
                            totalInputTokens += usage.input_tokens || 0;
                            totalOutputTokens += usage.output_tokens || 0;
                            totalCacheCreationInputTokens +=
                                usage.cache_creation_input_tokens || 0;
                            totalCacheReadInputTokens +=
                                usage.cache_read_input_tokens || 0;
                        }

                        // Complete any pending tool call (should ideally be handled by content_block_stop)
                        if (currentToolCall) {
                            // If a tool call is still active here, it means content_block_stop might not have fired correctly.
                            // Log a warning and potentially try to finalize/yield it.
                            console.warn(
                                'Tool call was still active at message_stop:',
                                currentToolCall
                            );

                            // Emit tool_start immediately when the block starts
                            yield {
                                type: 'tool_start',
                                tool_calls: [currentToolCall as ToolCall],
                            };
                            currentToolCall = null; // Reset anyway
                        }

                        // Flush any buffered deltas before final message_complete
                        for (const ev of flushBufferedDeltas(
                            deltaBuffers,
                            (_id, content) =>
                                ({
                                    type: 'message_delta',
                                    content,
                                    message_id: messageId,
                                    order: deltaPosition++,
                                }) as StreamingEvent
                        )) {
                            yield ev;
                        }
                        // Emit message_complete if there's content
                        if (accumulatedContent || accumulatedThinking) {
                            // Add footnotes if there are citations
                            if (citationTracker.citations.size > 0) {
                                const footnotes =
                                    generateFootnotes(citationTracker);
                                accumulatedContent += footnotes;
                            }

                            yield {
                                type: 'message_complete',
                                message_id: messageId,
                                content: accumulatedContent,
                                thinking_content: accumulatedThinking,
                                thinking_signature: accumulatedSignature,
                            };
                            messageCompleteYielded = true; // Mark that it was yielded here
                        }
                        streamCompletedSuccessfully = true; // Mark stream as complete
                        // **Cost tracking moved after the loop**
                    }
                    // Handle error event
                    else if (event.type === 'error') {
                        log_llm_error(requestId, event);
                        console.error('Claude API error event:', event.error);
                        yield {
                            type: 'error',
                            error:
                                'Claude API error: ' +
                                (event.error
                                    ? event.error.message ||
                                      JSON.stringify(event.error)
                                    : 'Unknown error'),
                        };
                        // Don't mark as successful on API error
                        streamCompletedSuccessfully = false;
                        break; // Stop processing on error
                    }
                } // End for await loop

                // Ensure a message_complete is emitted if somehow message_stop didn't fire
                // but we have content and no error occurred.
                if (
                    streamCompletedSuccessfully &&
                    (accumulatedContent || accumulatedThinking) &&
                    !messageCompleteYielded
                ) {
                    console.warn(
                        'Stream finished successfully but message_stop might not have triggered message_complete emission. Emitting now.'
                    );
                    // Flush any buffered deltas before final message_complete
                    for (const ev of flushBufferedDeltas(
                        deltaBuffers,
                        (_id, content) =>
                            ({
                                type: 'message_delta',
                                content,
                                message_id: messageId,
                                order: deltaPosition++,
                            }) as StreamingEvent
                    )) {
                        yield ev;
                    }
                    // Add footnotes if there are citations (same as in message_stop)
                    if (citationTracker.citations.size > 0) {
                        const footnotes = generateFootnotes(citationTracker);
                        accumulatedContent += footnotes;
                    }

                    yield {
                        type: 'message_complete',
                        message_id: messageId,
                        content: accumulatedContent,
                        thinking_content: accumulatedThinking,
                        thinking_signature: accumulatedSignature,
                    };
                    messageCompleteYielded = true; // Mark as yielded here too
                }
            } catch (streamError) {
                log_llm_error(requestId, streamError);
                console.error('Error processing Claude stream:', streamError);
                yield {
                    type: 'error',
                    error: `Claude stream error (${model}): ${streamError}`,
                };
            } finally {
                log_llm_response(requestId, events);
            }
        } catch (error) {
            log_llm_error(requestId, error);
            console.error('Error in Claude streaming completion setup:', error);
            yield {
                type: 'error',
                error: `Claude request error (${model}): ${error}`,
            };
        } finally {
            // Track cost if we have token usage data
            if (totalInputTokens > 0 || totalOutputTokens > 0) {
                const cachedTokens =
                    totalCacheCreationInputTokens + totalCacheReadInputTokens;
                costTracker.addUsage({
                    model,
                    input_tokens: totalInputTokens,
                    output_tokens: totalOutputTokens,
                    cached_tokens: cachedTokens,
                    metadata: {
                        cache_creation_input_tokens:
                            totalCacheCreationInputTokens,
                        cache_read_input_tokens: totalCacheReadInputTokens,
                        total_tokens: totalInputTokens + totalOutputTokens,
                    },
                });
            }
        }
    }
}

// Export an instance of the provider
export const claudeProvider = new ClaudeProvider();
