/**
 * Claude Code model provider for the MAGI system.
 *
 * This module uses claude-cli to run the Claude AI coding tool via its command-line interface.
 * It streams the output in real-time, cleans it, filters noise, yields text deltas using
 * a sliding window history for deduplication, skips initial prompt echo, filters the start signal,
 * and extracts final metadata (cost, duration).
 *
 * --- IMPORTANT ---
 * This provider relies on parsing the unstructured text output of the 'claude' CLI tool.
 * Functions like `isNoiseLine`, `isProcessingStartSignal`, and the metadata extraction
 * in the handler code are based on observed patterns in the current CLI version.
 * Future updates to the 'claude' CLI tool may change its output format,
 * potentially breaking the filtering, start signal detection, or metadata parsing.
 * These sections may require updates if the CLI tool is upgraded.
 * --- END IMPORTANT ---
 */

import { v4 as uuidv4 } from 'uuid';
import {
    ModelProvider,
    StreamingEvent,
    ResponseInput,
    MessageEvent,
} from '../types/shared-types.js';
import { costTracker } from '../utils/cost_tracker.js';
import { get_working_dir, log_llm_request } from '../utils/file_utils.js';
import type { Agent } from '../utils/agent.js';
import { findModel } from '../../../ensemble/model_providers/model_data.js';
import { runPty, PtyRunOptions } from '../utils/run_pty.js';
import { acquireSlot, releaseSlot } from '../utils/claude_db_limiter.js';
import { codexProvider } from './codex.js';

/**
 * Convert human-readable number strings to integers.
 * Handles values like "1.9k", "2M", "3_456", "987,654" etc.
 *
 * @param str - Human-readable number string
 * @returns Parsed integer value
 */
function humanReadableToInt(str: string): number {
    // Remove commas, underscores, spaces
    const normalized = str.replace(/[,_\s]/g, '');
    // Extract number and optional suffix
    const match = normalized.match(/^([\d.]+)([kKmMbB]?)$/);

    if (!match) {
        throw new Error(`Invalid human-readable number format: ${str}`);
    }

    const [, numStr, suffix = ''] = match;
    const num = parseFloat(numStr);

    // Convert based on suffix
    const MULTIPLIERS: Record<string, number> = {
        '': 1,
        k: 1000,
        K: 1000,
        m: 1000000,
        M: 1000000,
        b: 1000000000,
        B: 1000000000,
    };

    return Math.round(num * MULTIPLIERS[suffix]);
}

/**
 * Extract token count from a progress/status line.
 * Handles formats like "203 tokens", "↑ 1.9k tokens", etc.
 *
 * @param line - Status line containing token information
 * @returns Parsed token count or null if no valid token count found
 */
function parseTokenProgress(line: string): number | null {
    const match = /\b(?:↑\s*)?([\d.,_a-zA-Z]+)\s*tokens\b/i.exec(line);
    if (!match) return null;

    try {
        return humanReadableToInt(match[1]);
    } catch {
        return null;
    }
}

/**
 * Helper function to filter out known noise patterns from the interactive CLI output.
 *
 * **WARNING:** This function is highly dependent on the specific output format of the
 * current 'claude' CLI version. Changes to UI elements, status messages, prompts, etc.,
 * in future CLI versions may require this function to be updated.
 *
 * @param line - A single line of text (after ANSI stripping and trimming).
 * @param tokenCb - Optional callback to receive detected token counts from status lines
 * @returns True if the line is considered noise, false otherwise.
 */
function isNoiseLine(line: string, tokenCb?: (n: number) => void): boolean {
    if (!line) return true; // Skip empty lines

    // --- Filtering based on observed output ---
    // NOTE: These patterns might break with future CLI updates.

    // UI Borders/Elements
    if (line.startsWith('╭') || line.startsWith('│') || line.startsWith('╰'))
        return true;
    if (line.startsWith('>')) return true; // Skip prompt lines like "> Tips for getting started:"
    if (line.includes('? for shortcuts')) return true;
    if (line.includes('Bypassing Permissions')) return true;
    if (line.includes('Auto-update failed')) return true;
    if (line.includes('Try claude doctor')) return true;
    if (line.includes('@anthropic-ai/claude-code')) return true;
    if (line.includes('Press Ctrl-C again to exit')) return true;

    // Dynamic Status/Progress Lines (specific patterns)
    // Matches dynamic status lines like "* Action... (Xs · esc to interrupt)" or "* Action... (Xs · details · esc to interrupt)"
    if (
        /^\s*[\p{S}\p{P}]\s*\w+…\s*\(\d+s(?:\s*·\s*.+?)?\s*·\s*[^)]+\)$/u.test(
            line
        )
    ) {
        // Extract token count from the line before filtering it out
        const tokenCount = parseTokenProgress(line);
        if (tokenCount !== null && tokenCb) {
            tokenCb(tokenCount);
        }
        return true;
    }
    // Note: Thinking/Task/Call/Bash/Read lines are handled by isProcessingStartSignal or history dedupe
    if (line === '⎿  Running…') return true; // Specific running message
    if (line.match(/^⎿\s*Read \d+ lines \(ctrl\+r to expand\)$/)) return true; // Matches "Read N lines..." status

    // Known Initial/Setup Messages & Prompt Echo Sections
    if (line.startsWith('✻ Welcome to')) return true;
    if (line.startsWith('/help for help')) return true;
    if (line.startsWith('cwd:')) return true;
    if (line.startsWith('✔ Found')) return true;
    if (line.startsWith('✔ Loaded')) return true;
    if (line.startsWith('Try "')) return true;
    if (line === 'Tips for getting started:') return true; // Specific prompt line
    if (line.match(/^\d+\. Run \/init to create/)) return true; // Specific prompt line
    if (line.match(/^\d+\. Use Claude to help/)) return true; // Specific prompt line
    if (line.match(/^\d+\. Be as specific as you would/)) return true; // Specific prompt line
    // Prompt section headers
    if (line === 'ENVIRONMENT INFO:') return true;
    if (line === 'IMPORTANT WARNINGS:') return true;
    if (line === 'LANGUAGE CHOICE:') return true;
    if (line === 'OUTPUT:') return true;
    if (line.startsWith('Magi thoughts:')) return true; // Filter internal monologue from prompt
    if (line.startsWith('James said:')) return true; // Filter user input from prompt

    // Cost/Summary lines - Filter them during streaming, parse at the end
    if (line === '------') return true;

    // Filter specific error messages seen in output if desired
    if (line.includes('command not found')) return true;
    if (line.includes('No such file or directory')) return true;
    if (line === '⎿  Error') return true; // Specific error status

    // If none of the noise patterns matched, it's considered useful content
    return false;
}

/**
 * Checks if a line indicates the start of the actual processing/response phase,
 * after the initial prompt echo or setup messages.
 *
 * **WARNING:** This function relies on specific "start signals" observed in the
 * current 'claude' CLI output. If these signals change in future versions,
 * the logic for skipping the initial prompt echo might fail.
 *
 * @param line - A single line of text (after ANSI stripping and trimming).
 * @returns True if the line signals processing start, false otherwise.
 */
function isProcessingStartSignal(line: string): boolean {
    // NOTE: These patterns might break with future CLI updates.
    // Add patterns that reliably appear only *after* the initial prompt/setup output
    if (/^\s*\p{S}\s*\w+…/u.test(line)) return true;
    if (
        line.startsWith('● ') ||
        line.startsWith('╭') ||
        line.startsWith('│') ||
        line.startsWith('╰')
    )
        return true; // Lines starting with ● often indicate actions/tasks
    if (line.startsWith('Task(')) return true; // Task descriptions
    return false;
}

/**
 * Implements the ModelProvider interface for interacting with the Claude Code CLI tool.
 * Streams responses in real-time using the run_pty utility.
 */
export class ClaudeCodeProvider implements ModelProvider {
    /**
     * Generates a response by executing the Claude Code CLI tool and streaming its output.
     *
     * @param model - Identifier for the model being used (e.g., 'claude-code-cli-streaming').
     * @param messages - An array of message objects representing the conversation history or prompt.
     * @returns An AsyncGenerator yielding StreamingEvent objects.
     */
    async *createResponseStream(
        model: string,
        messages: ResponseInput,
        agent: Agent
    ): AsyncGenerator<StreamingEvent> {
        const messageId = uuidv4();

        // Try to acquire a Claude slot or fall back to Codex
        let slot = undefined;
        try {
            slot = await acquireSlot(messageId);
        } catch (error) {
            // Concurrency limit reached, fall back to Codex
            console.log(
                `[ClaudeCodeProvider] Concurrency limit reached, falling back to Codex for message ${messageId}`
            );

            // Delegate to Codex provider
            for await (const event of codexProvider.createResponseStream(
                model,
                messages,
                agent
            )) {
                yield event;
            }

            // Exit early - Codex has handled the request
            return;
        }

        // If we get here, we successfully acquired a Claude slot
        // Continue with the normal Claude code provider logic
        try {
            let accumulatedCleanOutput = ''; // For metadata parsing
            let finalContent = ''; // Accumulate actual yielded content for message_complete

            // --- Token Tracking for Cost Estimation ---
            let liveOutputTokens = 0;
            let costReceived = false;

            const updateLiveTokenEstimate = (n: number) => {
                if (n > liveOutputTokens) {
                    liveOutputTokens = n;
                    console.log(
                        `[ClaudeCodeProvider] Updated token count: ${liveOutputTokens} for message ${messageId}`
                    );
                }
            };

            // Define line hook for accumulating clean output
            const lineHook = (line: string) => {
                if (line) {
                    accumulatedCleanOutput += line + '\n';

                    // Detect cost summary as soon as it appears
                    if (!costReceived && line.includes('Total cost')) {
                        costReceived = true;
                        console.log(
                            `[ClaudeCodeProvider] Cost summary detected for message ${messageId}`
                        );
                    }
                }
            };

            // Process metadata at the end of the stream
            // Variables to track duration metadata
            let finalApiDuration: string | null = null;
            let finalWallDuration: string | null = null;

            const processFinalMetadata = () => {
                // --- Extract final metadata (cost, duration) ---
                try {
                    // Parse cost summary using regex
                    const costMatch = accumulatedCleanOutput.match(
                        /Total cost\s*:[\s\t]*\$([\d.]+)/m
                    );
                    const apiDurationMatch = accumulatedCleanOutput.match(
                        /Total duration \(API\)\s*:[\s\t]*([\d.]+s?)/m
                    );
                    const wallDurationMatch = accumulatedCleanOutput.match(
                        /Total duration \(wall\)\s*:[\s\t]*([\d.]+s?)/m
                    );

                    // Extract API and wall duration if available
                    finalApiDuration =
                        apiDurationMatch && apiDurationMatch[1]
                            ? apiDurationMatch[1]
                            : null;
                    finalWallDuration =
                        wallDurationMatch && wallDurationMatch[1]
                            ? wallDurationMatch[1]
                            : null;

                    if (finalApiDuration) {
                        console.log(
                            `[ClaudeCodeProvider] Extracted API duration: ${finalApiDuration}`
                        );
                    }
                    if (finalWallDuration) {
                        console.log(
                            `[ClaudeCodeProvider] Extracted wall duration: ${finalWallDuration}`
                        );
                    }

                    // Extract tokens from the "Token usage by model" section
                    const tokenUsageRe =
                        /^\s*(\S+):\s*([\d.,_a-zA-Z]+)\s+input,\s*([\d.,_a-zA-Z]+)\s+output/gim;

                    let parsedInputTokens = 0;
                    let parsedOutputTokens = 0;
                    let totalPreciseCost = 0;

                    // Collect all token usages by model and sum them
                    for (const m of accumulatedCleanOutput.matchAll(
                        tokenUsageRe
                    )) {
                        try {
                            const modelName = m[1].trim();
                            const inTok = humanReadableToInt(m[2]);
                            const outTok = humanReadableToInt(m[3]);

                            console.log(
                                `[ClaudeCodeProvider] Found token usage for ${modelName}: ${inTok} input, ${outTok} output`
                            );

                            // Add to totals
                            parsedInputTokens += inTok;
                            parsedOutputTokens += outTok;

                            // Try to get precise pricing from model registry
                            let modelEntry = findModel(modelName);

                            // If not found, try with -latest suffix (common pattern for Claude models)
                            if (!modelEntry && !modelName.endsWith('-latest')) {
                                modelEntry = findModel(`${modelName}-latest`);
                            }

                            if (
                                modelEntry &&
                                typeof modelEntry.cost.input_per_million ===
                                    'number' &&
                                typeof modelEntry.cost.output_per_million ===
                                    'number'
                            ) {
                                // Calculate precise cost using model-specific pricing
                                const modelCost =
                                    (inTok / 1_000_000) *
                                        modelEntry.cost.input_per_million +
                                    (outTok / 1_000_000) *
                                        modelEntry.cost.output_per_million;

                                totalPreciseCost += modelCost;

                                console.log(
                                    `[ClaudeCodeProvider] Calculated precise cost for ${modelName}: $${modelCost.toFixed(6)}`
                                );
                            }
                        } catch (e) {
                            console.warn(
                                `[ClaudeCodeProvider] Failed to parse token usage: ${e}`
                            );
                        }
                    }

                    // Construct the prompt to estimate token count if needed
                    const prompt = messages
                        .map(msg => {
                            let textContent = '';
                            if ('content' in msg) {
                                if (typeof msg.content === 'string') {
                                    textContent = msg.content;
                                } else if (Array.isArray(msg.content)) {
                                    textContent = msg.content
                                        .filter(
                                            part => part.type === 'input_text'
                                        )
                                        .map(part => (part as any).text)
                                        .join('\n');
                                }
                            }
                            return textContent;
                        })
                        .filter(Boolean)
                        .join('\n\n---\n');

                    // Calculate token counts, using parsed values if available
                    const input_tokens =
                        parsedInputTokens > 0
                            ? parsedInputTokens
                            : Math.ceil((prompt?.length || 0) / 4);

                    let output_tokens = 0;
                    let cost = 0;

                    // First try to extract the cost from the output summary
                    if (costMatch && costMatch[1]) {
                        cost = parseFloat(costMatch[1]);
                        if (isNaN(cost)) {
                            cost = 0;
                        }

                        // Set output token count based on parsed value or fallback to estimate
                        output_tokens =
                            parsedOutputTokens > 0
                                ? parsedOutputTokens
                                : Math.ceil(finalContent.length / 4);
                    } else if (totalPreciseCost > 0) {
                        // Use precise model-based cost calculation if available
                        cost = totalPreciseCost;
                        output_tokens = parsedOutputTokens;

                        console.log(
                            `[ClaudeCodeProvider] Using precise model-based cost calculation: $${cost.toFixed(6)}`
                        );
                    } else {
                        // Set output token count based on parsed value or fallbacks
                        output_tokens =
                            parsedOutputTokens > 0
                                ? parsedOutputTokens
                                : liveOutputTokens ||
                                  Math.ceil(finalContent.length / 4);

                        // Estimate pricing: $3/1M input tokens, $15/1M output tokens
                        const inputCost = (input_tokens * 0.003) / 1000;
                        const outputCost = (output_tokens * 0.015) / 1000;
                        cost = inputCost + outputCost;
                        console.log(
                            `[ClaudeCodeProvider] Estimated cost for Sonnet: $${cost.toFixed(6)}`
                        );
                    }

                    console.log(
                        `[ClaudeCodeProvider] Extracted cost from stream: $${cost.toFixed(6)}`
                    );

                    // Log usage to cost tracker
                    costTracker.addUsage({
                        model,
                        cost,
                        input_tokens,
                        output_tokens,
                        metadata: {
                            api_duration:
                                parseFloat(finalApiDuration || '0') || 0,
                            wall_duration:
                                parseFloat(finalWallDuration || '0') || 0,
                        },
                    });

                    // Return metadata for message_complete
                    return {
                        cost,
                        apiDuration: finalApiDuration,
                        wallDuration: finalWallDuration,
                    };
                } catch (metadataParseError: any) {
                    // Log if parsing fails, but don't block completion
                    console.warn(
                        `[ClaudeCodeProvider] Failed to parse metadata from accumulated output: ${metadataParseError.message}`
                    );
                    return null;
                }
            };

            // 1. Construct the prompt string from input messages.
            const prompt = messages
                .map(msg => {
                    let textContent = '';
                    if ('content' in msg) {
                        if (typeof msg.content === 'string') {
                            textContent = msg.content;
                        } else if (Array.isArray(msg.content)) {
                            textContent = msg.content
                                .filter(part => part.type === 'input_text')
                                .map(part => (part as any).text)
                                .join('\n');
                        }
                    }
                    return textContent;
                })
                .filter(Boolean)
                .join('\n\n---\n');

            if (!prompt) {
                throw new Error(
                    'Cannot run Claude CLI: Constructed prompt is empty.'
                );
            }

            // 2. Get working directory and log request
            const cwd =
                agent.cwd && agent.cwd.trim()
                    ? agent.cwd
                    : get_working_dir() || process.cwd();

            console.log(
                `[ClaudeCodeProvider] Executing streaming Claude CLI for model '${model}' in dir '${cwd}'...`
            );

            log_llm_request(agent.agent_id, 'anthropic', model, {
                prompt:
                    prompt.substring(0, 100) +
                    (prompt.length > 100 ? '...' : ''),
                working_directory: cwd,
            });

            // 3. Define runPty options
            const ptyOpts: PtyRunOptions = {
                cwd,
                messageId,
                noiseFilter: isNoiseLine,
                startSignal: isProcessingStartSignal,
                onTokenProgress: updateLiveTokenEstimate,
                onLine: lineHook,
                silenceTimeoutMs: 5000,
                env: {
                    ...process.env,
                    DISABLE_AUTOUPDATER: '1',
                },
                emitComplete: false, // Provider will decide when to emit complete event
            };

            // 4. Run Claude CLI command via run_pty utility
            const { stream } = runPty(
                'claude',
                ['--dangerously-skip-permissions', prompt],
                ptyOpts
            );

            // 5. Process stream events - track the highest order value
            let deltaPosition = 0;
            for await (const event of stream) {
                // For message_delta events, accumulate content for final completion event
                if (event.type === 'message_delta' && 'content' in event) {
                    finalContent += event.content;

                    // Track the highest order value we've seen
                    if (
                        'order' in event &&
                        typeof event.order === 'number' &&
                        event.order > deltaPosition
                    ) {
                        deltaPosition = event.order;
                    }
                }

                // Pass through the event
                yield event;
            }

            // 6. Process completed - emit our own message_complete with metadata
            const metadata = processFinalMetadata();

            // Use the next sequential order number after the last delta
            const completeEvent: MessageEvent & {
                metadata?: Record<string, any>;
            } = {
                type: 'message_complete',
                message_id: messageId,
                content: finalContent,
                order: deltaPosition + 1, // Use next sequential order number
            };

            // Add metadata if available
            if (metadata) {
                completeEvent.metadata = metadata;
            }

            // Log final status
            console.log(
                `[ClaudeCodeProvider] Stream completed successfully for message ${messageId}.`
            );

            // Yield final complete event
            yield completeEvent;
        } catch (error: unknown) {
            console.error(
                '[ClaudeCodeProvider] Error during Claude Code streaming execution:',
                error
            );
            const errorMessage = String(error);

            yield {
                type: 'error',
                error: `Claude code provider stream error: ${errorMessage}`,
                agent: undefined,
            };
        } finally {
            // Ensure proper cleanup on both success and error paths
            console.log(
                `[ClaudeCodeProvider] Finalizing Claude Code provider for message ${messageId}`
            );

            // Always release the Claude slot if we acquired one
            if (slot) {
                await releaseSlot(slot);
            }
        }
    }
}

// Export a singleton instance of the provider
export const claudeCodeProvider = new ClaudeCodeProvider();
