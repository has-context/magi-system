/**
 * MECH State management
 *
 * This module manages the state for the Meta-cognition Ensemble Chain-of-thought Hierarchy (MECH) system.
 * It provides a central state container and methods to modify the system's behavior at runtime.
 */

import { ToolFunction, type ModelClassID } from '../types/shared-types.js';
import { createToolFunction } from './tool_call.js';
import { addHistory } from './history.js';
import { spawnMetaThought } from './meta_cognition.js';
import {
    findModel,
    MODEL_CLASSES,
} from '../../../ensemble/model_providers/model_data.js';
import { Agent } from './agent.js';
import { getThoughtTools } from './thought_utils.js';

export type MetaFrequency = '5' | '10' | '20' | '40';
export const validFrequencies: string[] = ['5', '10', '20', '40'];

/**
 * State container for the MECH system
 */
export interface MECHState {
    /** Counter for LLM requests to trigger meta-cognition */
    llmRequestCount: number;

    /** How often meta-cognition should run (every N LLM requests) */
    metaFrequency: MetaFrequency;

    /** Set of model IDs that have been temporarily disabled */
    disabledModels: Set<string>;

    /** Model effectiveness scores (0-100) - higher scores mean the model is selected more often */
    modelScores: Record<string, number>;

    /** Last model used, to ensure rotation */
    lastModelUsed?: string;
}

/**
 * Global MECH state
 */
export const mechState: MECHState = {
    llmRequestCount: 0,
    metaFrequency: '5',
    disabledModels: new Set<string>(),
    modelScores: {},
};

export function listDisabledModels(): string {
    if (mechState.disabledModels.size === 0) {
        return '- No models disabled';
    } else {
        return `- ${Array.from(mechState.disabledModels).join('\n- ')}`;
    }
}

export function listModelScores(modelClass?: ModelClassID): string {
    if (modelClass && MODEL_CLASSES[modelClass]?.models?.length > 0) {
        return MODEL_CLASSES[modelClass].models
            .map(
                modelId => `- ${modelId}: ${getModelScore(modelId, modelClass)}`
            )
            .join('\n');
    }
    if (Object.keys(mechState.modelScores).length === 0) {
        return '- No model scores set';
    }
    return Object.entries(mechState.modelScores)
        .map(([modelId, score]) => `- ${modelId}: ${score}`)
        .join('\n');
}

/**
 * Set how often meta-cognition should run (every N LLM requests)
 * @param frequency - The frequency to set (5, 10, 20, or 40)
 * @returns The new frequency
 */
export function set_meta_frequency(frequency: string): MetaFrequency {
    if (validFrequencies.includes(frequency)) {
        mechState.metaFrequency = frequency as MetaFrequency; // Cast to MetaFrequency type
    }
    return mechState.metaFrequency;
}

/**
 * Set the score for a specific model
 * @param modelId - The model ID to score
 * @param score - Score between 0-100, higher is better
 * @returns The new score
 */
export function set_model_score(modelId: string, score: number): string {
    // Ensure score is within valid range
    score = Math.max(0, Math.min(100, score));
    mechState.modelScores[modelId] = score;
    console.log(`[MECH] Model ${modelId} score set to ${score}`);
    return String(score);
}

/**
 * Disable a model so it won't be selected
 * @param modelId - The model ID to disable
 */
export function disable_model(modelId: string, disabled?: boolean): string {
    if (disabled === false) {
        return enableModel(modelId);
    }
    mechState.disabledModels.add(modelId);
    return `Model ${modelId} disabled`;
}

/**
 * Enable a previously disabled model
 * @param modelId - The model ID to enable
 */
export function enableModel(modelId: string): string {
    mechState.disabledModels.delete(modelId);
    return `Model ${modelId} enabled`;
}

/**
 * Get the score for a model, optionally for a specific model class
 * @param modelId - The model ID to get the score for
 * @param modelClass - Optional model class to get a class-specific score
 * @returns The model's score (0-100)
 */
export function getModelScore(modelId: string, modelClass?: string): number {
    // First check if we have a score in mechState
    if (modelId in mechState.modelScores) {
        return mechState.modelScores[modelId];
    }

    // If not in mechState, look up the model entry
    const modelEntry = findModel(modelId);

    if (modelEntry) {
        // If a specific class is requested, check if there's a class-specific score
        if (modelClass && modelEntry.scores && modelEntry.scores[modelClass]) {
            return modelEntry.scores[modelClass];
        }

        // Fall back to general score if available
        if (modelEntry.score !== undefined) {
            return modelEntry.score;
        }
    }

    // Default score is 50
    return 50;
}

/**
 * Increment the LLM request counter
 * @returns The new count and whether meta-cognition should trigger
 */
export function incrementLLMRequestCount(): {
    count: number;
    shouldTriggerMeta: boolean;
} {
    mechState.llmRequestCount++;
    const shouldTriggerMeta =
        mechState.llmRequestCount % parseInt(mechState.metaFrequency) === 0;

    if (shouldTriggerMeta) {
        console.log(
            `[MECH] Meta-cognition trigger point reached at ${mechState.llmRequestCount} LLM requests`
        );
    }

    return {
        count: mechState.llmRequestCount,
        shouldTriggerMeta,
    };
}

export async function spawnMetaThoughtIfNeeded(agent: Agent): Promise<void> {
    // Check if we need to trigger meta-cognition
    const { shouldTriggerMeta } = incrementLLMRequestCount();
    if (shouldTriggerMeta) {
        console.log(
            `[MECH] Triggering meta-cognition after ${mechState.llmRequestCount} LLM requests`
        );
        try {
            await spawnMetaThought(agent);
        } catch (error) {
            console.error('[MECH] Error in meta-cognition:', error);
        }
    }
}

/**
 * Create a thought that will be injected into the history
 * @param content - The thought content to inject
 * @returns Message indicating success
 */
function inject_thought(content: string): string {
    addHistory({
        type: 'message',
        role: 'developer',
        content: `**IMPORTANT - METACOGNITION:** ${content}`,
    });

    console.log(`[MECH] metacognition injected thought: ${content}`);
    return `Successfully injected metacognition thought at ${new Date().toISOString()}`;
}

function no_changes_needed(): string {
    console.log('[MECH] metacognition no change');
    return 'No changes made';
}

/**
 * Get all metacognition tools as an array of tool definitions
 * These are available only to the metacognition agent, not the main agent
 */
export function getMetaCognitionTools(): ToolFunction[] {
    return [
        createToolFunction(
            inject_thought,
            'Your core tool for altering the thought process of the agent. Injects a thought with high priority into the next loop for the agent. The agent will see this before choosing their next thought or action.',
            {
                content:
                    'The thought to inject. Be detailed and explain why this is important.',
            }
        ),
        ...getThoughtTools(),
        createToolFunction(
            set_meta_frequency,
            'Change how often metacognition should run (every N LLM requests)',
            {
                frequency: {
                    // Wrap enum in a ToolParameter object
                    type: 'string',
                    description:
                        'Frequency value (5, 10, 20, or 40 LLM requests)',
                    enum: validFrequencies,
                },
            },
            'Confirmation message' // Added return description
        ),
        createToolFunction(
            set_model_score,
            'Set a score for a specific model (affects selection frequency)',
            {
                modelId: 'The model ID to score',
                score: 'Score between 0-100, higher means the model is selected more often',
            },
            'The new score for the model' // Added return description
        ),
        createToolFunction(
            disable_model,
            'Temporarily disable a model from being selected. Pass disabled=false to enable it again.',
            {
                modelId: 'The model ID to change',
                disabled: {
                    type: 'boolean',
                    description:
                        'Whether to disable the model (true) or enable it (false)',
                    optional: true,
                    default: true,
                },
            }
        ),
        createToolFunction(
            no_changes_needed,
            'Everything is perfect. Use when no other tools are needed.'
        ),
    ];
}
