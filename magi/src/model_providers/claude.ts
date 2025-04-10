/**
 * Claude model provider for the MAGI system.
 *
 * This module provides an implementation of the ModelProvider interface
 * for Anthropic's Claude models and handles streaming responses.
 */

import Anthropic from '@anthropic-ai/sdk';
import {v4 as uuidv4} from 'uuid';
import {
	ModelProvider,
	ToolFunction,
	ModelSettings,
	StreamingEvent,
	ToolCall,
	ResponseInput, ResponseInputItem
} from '../types.js';
import { costTracker } from '../utils/cost_tracker.js';
import { log_llm_request } from '../utils/file_utils.js';
import { convertHistoryFormat } from '../utils/llm_utils.js'; // Re-import
import {Agent} from '../utils/agent.js';
import {ModelClassID} from './model_data.js';

// Convert our tool definition to Claude's format
function convertToClaudeTools(tools: ToolFunction[]): any[] {
	return tools.map(tool => ({
		// Directly map the properties to the top level
		name: tool.definition.function.name,
		description: tool.definition.function.description,
		// Map 'parameters' from your definition to 'input_schema' for Claude
		input_schema: tool.definition.function.parameters
	}));
}

// Assuming ResponseInputItem is your internal message structure type
// Assuming ClaudeMessage is the structure Anthropic expects (or null)
type ClaudeMessage = { role: 'user' | 'assistant' | 'system'; content: any; } | null; // Simplified type

/**
 * Converts a custom ResponseInputItem into Anthropic Claude's message format.
 * Handles text messages, tool use requests (function calls), and tool results (function outputs).
 *
 * @param role The original role associated with the message ('user', 'assistant', 'system').
 * @param content The text content, primarily for non-tool messages.
 * @param msg The detailed message object (ResponseInputItem).
 * @returns A Claude message object or null if conversion is not applicable (e.g., system message, empty content).
 */
function convertToClaudeMessage(role: string, content: string, msg: ResponseInputItem): ClaudeMessage {
	if(!msg) return null;

	// --- Handle Tool Use (Function Call) ---
	if (msg.type && msg.type === 'function_call') {
		let inputArgs: Record<string, unknown> = {};
		try {
			// Claude expects 'input' as an object
			inputArgs = JSON.parse(msg.arguments || '{}');
		} catch (e) {
			console.error(`Error parsing function call arguments for ${msg.name}: ${msg.arguments}`, e);
			return null;
		}

		const toolUseBlock = {
			type: 'tool_use',
			id: msg.call_id, // Use the consistent ID field
			name: msg.name,
			input: inputArgs,
		};

		return {role: 'assistant', content: [toolUseBlock]};
	} else if (msg.type && msg.type === 'function_call_output') {
		const toolResultBlock = {
			type: 'tool_result',
			tool_use_id: msg.call_id, // ID must match the corresponding tool_use block
			content: msg.output || '', // Default to empty string if output is missing
			...(msg.status === 'incomplete' ? {is_error: true} : {}),
		};

		// Anthropic expects role: 'user' for tool_result
		return {role: 'user', content: [toolResultBlock]};
	} else if (msg.type && msg.type === 'thinking') {
		if(!content || !msg.signature) {
			return null; // Can't process thinking without content and signature
		}

		// Return a thinking message with the content and signature
		return {role: 'assistant', content: [{
			type: 'thinking',
			thinking: content,
			signature: msg.signature
		}]};
	} else {
		// Skip messages with no actual text content
		if (!content) {
			return null; // Skip messages with no text content
		}


		// System messages expect string content
		if (role === 'system' || role === 'developer') {
			// System prompts are handled separately later
			return {role: 'system', content: content};
		} else {
			const messageRole = role === 'assistant' ? 'assistant' : 'user';
			// User and Assistant messages must use the array format when tools are potentially involved.
			// Use array format consistently for safety.
			return {
				role: messageRole,
				content: [{type: 'text', text: content}]
			};
		}
	}
	// Default case for unhandled or irrelevant message types for Claude history
	return null;
}

/**
 * Claude model provider implementation
 */
export class ClaudeProvider implements ModelProvider {
	private client: Anthropic;

	constructor(apiKey?: string) {
		this.client = new Anthropic({
			apiKey: apiKey || process.env.ANTHROPIC_API_KEY
		});

		if (!this.client) {
			throw new Error('Failed to initialize Claude client. Make sure ANTHROPIC_API_KEY is set.');
		}
	}

	/**
	 * Create a streaming completion using Claude's API
	 */
	async* createResponseStream(
		model: string,
		messages: ResponseInput,
		agent?: Agent,
	): AsyncGenerator<StreamingEvent> {
		// --- Usage Accumulators ---
		let totalInputTokens = 0;
		let totalOutputTokens = 0;
		let totalCacheCreationInputTokens = 0;
		let totalCacheReadInputTokens = 0;
		let streamCompletedSuccessfully = false; // Flag to track successful stream completion
		let messageCompleteYielded = false; // Flag to track if message_complete was yielded

		try {
			const tools: ToolFunction[] | undefined = agent?.tools;
			const settings: ModelSettings | undefined = agent?.modelSettings;
			const modelClass: ModelClassID | undefined = agent?.modelClass;

			let thinking = undefined;
			let max_tokens = settings?.max_tokens || 64000; // Default max tokens if not specified
			switch (modelClass) {
				case 'monologue':
				case 'reasoning':
				case 'code':
					if(model === 'claude-3-7-sonnet-latest') {
						// Extended thinking
						thinking = {
									type: 'enabled',
									budget_tokens: 16000
						};
						max_tokens = Math.min(max_tokens, 64000);
					}
					else {
						max_tokens = Math.min(max_tokens, 8192);
					}
					break;
				case 'standard':
					max_tokens = Math.min(max_tokens, 8192);
					break;
				default:
					max_tokens = Math.min(max_tokens, 4096); // Lower limit for other classes
			}

			// Convert messages format for Claude using the generic converter and Claude-specific map
			const claudeMessages = convertHistoryFormat(messages, convertToClaudeMessage);

			// Ensure content is a string. Handle cases where content might be structured differently or missing.
			const systemPrompt = claudeMessages.reduce(
				(acc, msg): string => {
					if (msg.role === 'system' && msg.content && typeof msg.content === 'string') {
						return acc + msg.content + '\n'; // Append system prompt content
					}
					return acc;
				}, ''
			);

			// Format the request according to Claude API specifications
			const requestParams: any = {
				model: model,
				// Filter for only user and assistant messages for the 'messages' array
				messages: claudeMessages.filter(m => m.role === 'user' || m.role === 'assistant'),
				// Add system prompt string if it exists
				...(systemPrompt ? { system: systemPrompt } : {}),
				stream: true,
				max_tokens,
				...(thinking ? { thinking } : {}),
				...(settings?.temperature !== undefined ? { temperature: settings.temperature } : {}),
			};

			// Add tools if provided, using the corrected conversion function
			if (tools && tools.length > 0) {
				requestParams.tools = convertToClaudeTools(tools); // Uses the corrected function
			}

			// Log the request before sending
			log_llm_request('anthropic', model, requestParams);

			// Make the API call
			const stream =  await this.client.messages.create(requestParams);

			// Track current tool call info
			let currentToolCall: any = null;
			let accumulatedSignature = '';
			let accumulatedThinking = '';
			let accumulatedContent = ''; // To collect all content for final message_complete
			const messageId = uuidv4(); // Generate a unique ID for this message
			// Track delta positions for ordered message chunks
			let deltaPosition = 0;

			try {
				// @ts-expect-error - Claude's stream is AsyncIterable but TypeScript might not recognize it properly
				for await (const event of stream) {

					// --- Accumulate Usage ---
					// Check message_start for initial usage (often includes input tokens)
					if (event.type === 'message_start' && event.message?.usage) {
						const usage = event.message.usage;
						totalInputTokens += usage.input_tokens || 0;
						totalOutputTokens += usage.output_tokens || 0; // Sometimes initial output tokens are here
						totalCacheCreationInputTokens += usage.cache_creation_input_tokens || 0;
						totalCacheReadInputTokens += usage.cache_read_input_tokens || 0;
					}
					// Check message_delta for incremental usage (often includes output tokens)
					else if (event.type === 'message_delta' && event.usage) {
						const usage = event.usage;
						// Input tokens shouldn't change mid-stream, but check just in case
						totalInputTokens += usage.input_tokens || 0;
						totalOutputTokens += usage.output_tokens || 0;
						totalCacheCreationInputTokens += usage.cache_creation_input_tokens || 0;
						totalCacheReadInputTokens += usage.cache_read_input_tokens || 0;
					}

					// --- Handle Content and Tool Events ---
					// Handle content block delta
					if (event.type === 'content_block_delta') {
						// Emit delta event for streaming UI updates with incrementing order
						if (event.delta.type === 'signature_delta' && event.delta.signature) {
							accumulatedSignature += event.delta.signature;
						}
						else if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
							yield {
								type: 'message_delta',
								content: '',
								thinking_content: event.delta.thinking,
								message_id: messageId,
								order: deltaPosition++
							};
							accumulatedThinking += event.delta.thinking;
						}
						else if (event.delta.type === 'text_delta' && event.delta.text) {
							yield {
								type: 'message_delta',
								content: event.delta.text,
								message_id: messageId,
								order: deltaPosition++
							};
							accumulatedContent += event.delta.text;
						}
						else if (event.delta.type === 'input_json_delta' && currentToolCall && event.delta.partial_json) {
							try {
								// Append the partial JSON string to the arguments
								// Note: This assumes arguments are always JSON stringified.
								// If arguments could be simple strings, this needs adjustment.
								// We might need a more robust way to reconstruct the JSON.
								// For now, appending might work for many cases but could break complex JSON.
								// A safer approach might be to accumulate the partial_json and parse at the end.
								// Let's try accumulating first.
								if (!currentToolCall.function._partialArguments) {
									currentToolCall.function._partialArguments = '';
								}
								currentToolCall.function._partialArguments += event.delta.partial_json;

								// Update the main arguments field for intermediate UI updates (best effort)
								currentToolCall.function.arguments = currentToolCall.function._partialArguments;

								// Yielding tool_start repeatedly might be noisy; consider yielding tool_delta if needed
								yield {
									type: 'tool_delta',
									tool_calls: [currentToolCall as ToolCall]
								};
							} catch (err) {
								console.error('Error processing tool_use delta (input_json_delta):', err, event);
							}
						}

					}
					// Handle content block start for text
					else if (event.type === 'content_block_start' &&
						event.content_block?.type === 'text') {
						if (event.content_block.text) {
							yield {
								type: 'message_delta',
								content: event.content_block.text,
								message_id: messageId,
								order: deltaPosition++
							};
							accumulatedContent += event.content_block.text;
						}
					}
					// Handle content block stop for text (less common for text deltas, but handle defensively)
					else if (event.type === 'content_block_stop' &&
						event.content_block?.type === 'text') {
						// No specific action needed here usually if deltas are handled,
						// but keep the structure in case API behavior changes.
					}
					// Handle tool use start
					else if (event.type === 'content_block_start' &&
						event.content_block?.type === 'tool_use') {
						const toolUse = event.content_block;
						const toolId = toolUse.id || `call_${Date.now()}`;
						const toolName = toolUse.name;
						const toolInput = toolUse.input !== undefined ? toolUse.input : {};
						currentToolCall = {
							id: toolId,
							type: 'function',
							function: {
								name: toolName,
								arguments: typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput)
							}
						};
					}
					// Handle tool use stop
					else if (event.type === 'content_block_stop' &&
						event.content_block?.type === 'tool_use' &&
						currentToolCall) {
						try {
							// Finalize arguments if they were streamed partially
							if (currentToolCall.function._partialArguments) {
								currentToolCall.function.arguments = currentToolCall.function._partialArguments;
								delete currentToolCall.function._partialArguments; // Clean up temporary field
							}
							yield {
								type: 'tool_start',
								tool_calls: [currentToolCall as ToolCall]
							};
						} catch (err) {
							console.error('Error finalizing tool call:', err, event);
						} finally {
							// Reset currentToolCall *after* potential final processing
							currentToolCall = null;
						}
					}
					// Handle message stop
					else if (event.type === 'message_stop') {
						// Check for any final usage info (less common here, but possible)
						// Note: The example payload doesn't show usage here, but the Anthropic SDK might add it.
						if (event['amazon-bedrock-invocationMetrics']) { // Check for Bedrock specific metrics if applicable
							const metrics = event['amazon-bedrock-invocationMetrics'];
							totalInputTokens += metrics.inputTokenCount || 0;
							totalOutputTokens += metrics.outputTokenCount || 0;
							// Add other Bedrock metrics if needed
						} else if (event.usage) { // Check standard usage object as a fallback
							const usage = event.usage;
							totalInputTokens += usage.input_tokens || 0;
							totalOutputTokens += usage.output_tokens || 0;
							totalCacheCreationInputTokens += usage.cache_creation_input_tokens || 0;
							totalCacheReadInputTokens += usage.cache_read_input_tokens || 0;
						}


						// Complete any pending tool call (should ideally be handled by content_block_stop)
						if (currentToolCall) {
							// If a tool call is still active here, it means content_block_stop might not have fired correctly.
							// Log a warning and potentially try to finalize/yield it.
							console.warn('Tool call was still active at message_stop:', currentToolCall);

							// Emit tool_start immediately when the block starts
							yield {
								type: 'tool_start',
								tool_calls: [currentToolCall as ToolCall]
							};
							currentToolCall = null; // Reset anyway
						}

						// Emit message_complete if there's content
						if (accumulatedContent || accumulatedThinking) {
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
						console.error('Claude API error event:', event.error);
						yield {
							type: 'error',
							error: 'Claude API error: '+(event.error ? (event.error.message || JSON.stringify(event.error)) : 'Unknown error')
						};
						// Don't mark as successful on API error
						streamCompletedSuccessfully = false;
						break; // Stop processing on error
					}
				} // End for await loop

				// Ensure a message_complete is emitted if somehow message_stop didn't fire
				// but we have content and no error occurred.
				if (streamCompletedSuccessfully && (accumulatedContent || accumulatedThinking) && !messageCompleteYielded) {
					console.warn('Stream finished successfully but message_stop might not have triggered message_complete emission. Emitting now.');
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
				console.error('Error processing Claude stream:', streamError);
				yield {
					type: 'error',
					error: 'Claude processing stream error: '+String(streamError)
				};
				streamCompletedSuccessfully = false; // Mark as failed

				// If we have accumulated content but no message_complete was sent
				// due to an error, still try to send it (optional, might be partial)
				/* if ((accumulatedContent || accumulatedThinking) && !messageCompleteYielded) {
				   yield {
					  type: 'message_complete',
						message_id: messageId,
						content: accumulatedContent,
						thinking_content: accumulatedThinking,
						thinking_signature: accumulatedSignature,
				   };
				} */
			}

		} catch (error) {
			console.error('Error in Claude streaming completion setup:', error);
			yield {
				type: 'error',
				error: 'Claude streaming setup error: '+ (error instanceof Error ? error.stack : String(error))
			};
			streamCompletedSuccessfully = false; // Mark as failed
		} finally {
			// --- Track Cost ---
			// Only track cost if the stream completed (or partially completed with some usage)
			// and we have accumulated some token counts.
			if (totalInputTokens > 0 || totalOutputTokens > 0 || totalCacheReadInputTokens > 0 || totalCacheCreationInputTokens > 0) {
				// Combine cache tokens as per the user's desired structure
				const cachedTokens = totalCacheCreationInputTokens + totalCacheReadInputTokens;

				costTracker.addUsage({
					model,
					input_tokens: totalInputTokens,
					output_tokens: totalOutputTokens,
					// Map accumulated Claude cache tokens to the 'cached_tokens' field
					cached_tokens: cachedTokens,
					metadata: {
						// Add specific cache breakdown if needed
						cache_creation_input_tokens: totalCacheCreationInputTokens,
						cache_read_input_tokens: totalCacheReadInputTokens,
						// Add other potential metadata if available/needed
						// reasoning_tokens: 0, // Not directly available from Claude usage object
						// tool_tokens: 0, // Not directly available from Claude usage object
						total_tokens: totalInputTokens + totalOutputTokens, // Calculate total
					},
				});
			} else if (streamCompletedSuccessfully) {
				// Log if stream completed but no tokens were recorded (might indicate an issue)
				console.warn(`Claude stream for model ${model} completed successfully but no token usage was recorded.`);
			}
		}
	}
}

// Export an instance of the provider
export const claudeProvider = new ClaudeProvider();
