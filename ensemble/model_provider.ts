/**
 * Model provider interface for the MAGI system.
 *
 * This module defines the ModelProvider interface and factory function
 * to get the appropriate provider implementation.
 */

import { ModelProvider as BaseModelProvider } from './types.js';

// Extend the base ModelProvider interface to add embedding support
export interface ModelProvider extends BaseModelProvider {
    /**
     * Creates embeddings for text input
     * @param modelId ID of the embedding model to use
     * @param input Text to embed (string or array of strings)
     * @param opts Optional parameters for embedding generation
     * @returns Promise resolving to embedding vector(s)
     */
    createEmbedding?(
        modelId: string,
        input: string | string[],
        opts?: EmbedOpts
    ): Promise<number[] | number[][]>;
}

/**
 * Optional parameters for embeddings
 */
export interface EmbedOpts {
    /**
     * A task-specific hint to the model for optimization
     * For Gemini models: 'SEMANTIC_SIMILARITY', 'CLASSIFICATION', 'CLUSTERING', 'RETRIEVAL_DOCUMENT', etc.
     */
    taskType?: string;

    /** Dimension of vector if model supports variable dimensions */
    dimensions?: number;

    /** Whether to normalize vectors to unit length */
    normalize?: boolean;
}
import { openaiProvider } from './openai.js';
import { claudeProvider } from './claude.js';
import { geminiProvider } from './gemini.js';
import { grokProvider } from './grok.js';
import { deepSeekProvider } from './deepseek.js';
import { testProvider } from './test_provider.js';
import { openRouterProvider } from './openrouter.js';
import { claudeCodeProvider } from '../code_providers/claude_code.js';
import { codexProvider } from '../code_providers/codex.js';
import { MODEL_CLASSES, ModelClassID, ModelProviderID } from './model_data.js';

// Provider mapping by model prefix
const MODEL_PROVIDER_MAP: Record<string, ModelProvider> = {
    // Coding models
    codex: codexProvider,
    'claude-code': claudeCodeProvider,

    // OpenAI models
    'gpt-': openaiProvider,
    o1: openaiProvider,
    o3: openaiProvider,
    o4: openaiProvider,
    'text-': openaiProvider,
    'computer-use-preview': openaiProvider,

    // Claude/Anthropic models
    'claude-': claudeProvider,

    // Gemini/Google models
    'gemini-': geminiProvider,

    // Grok/X.AI models
    'grok-': grokProvider,

    // DeepSeek models
    'deepseek-': deepSeekProvider,

    // Test provider for testing
    'test-': testProvider,
};

/**
 * Check if an API key for a model provider exists and is valid
 */
export function isProviderKeyValid(provider: ModelProviderID): boolean {
    // Basic check to see if an API key exists with the expected format
    switch (provider) {
        case 'openai':
            return (
                !!process.env.OPENAI_API_KEY &&
                process.env.OPENAI_API_KEY.startsWith('sk-')
            );
        case 'anthropic':
            return (
                !!process.env.ANTHROPIC_API_KEY &&
                process.env.ANTHROPIC_API_KEY.startsWith('sk-ant-')
            );
        case 'google':
            return !!process.env.GOOGLE_API_KEY;
        case 'xai':
            return (
                !!process.env.XAI_API_KEY &&
                process.env.XAI_API_KEY.startsWith('xai-')
            );
        case 'deepseek':
            return (
                !!process.env.DEEPSEEK_API_KEY &&
                process.env.DEEPSEEK_API_KEY.startsWith('sk-')
            );
        case 'openrouter':
            return !!process.env.OPENROUTER_API_KEY;
        case 'test':
            return true; // Test provider is always valid
        default:
            return false;
    }
}

/**
 * Get the provider name from a model name
 */
export function getProviderFromModel(model: string): ModelProviderID {
    if (
        model.startsWith('gpt-') ||
        model.startsWith('o1') ||
        model.startsWith('o3') ||
        model.startsWith('o4') ||
        model.startsWith('text-') ||
        model.startsWith('computer-use-preview')
    ) {
        return 'openai';
    } else if (model.startsWith('claude-')) {
        return 'anthropic';
    } else if (model.startsWith('gemini-')) {
        return 'google';
    } else if (model.startsWith('grok-')) {
        return 'xai';
    } else if (model.startsWith('deepseek-')) {
        return 'deepseek';
    } else if (model.startsWith('test-')) {
        return 'test';
    }
    return 'openrouter'; // Default to OpenRouter if no specific provider found
}

/**
 * Get a suitable model from a model class, with fallback
 */
export async function getModelFromClass(
    modelClass?: ModelClassID
): Promise<string> {
    // Import via dynamic import to avoid circular dependencies
    // Using dynamic import instead of require to comply with ESM standards
    const QuotaModule = await import('../utils/quota_manager.js');
    const quotaManager = QuotaModule.quotaManager;

    // Convert modelClass to a string to avoid TypeScript errors
    const modelClassStr = modelClass as string;

    // Default to standard class if none specified or if the class doesn't exist in MODEL_CLASSES
    const modelGroup =
        modelClassStr && modelClassStr in MODEL_CLASSES
            ? modelClassStr
            : 'standard';

    // Try each model in the group until we find one with a valid API key and quota
    if (modelGroup in MODEL_CLASSES) {
        // Type assertion here is safe because we've already checked that modelGroup is a key in MODEL_CLASSES
        const modelClassConfig =
            MODEL_CLASSES[modelGroup as keyof typeof MODEL_CLASSES];
        let models = [...modelClassConfig.models];

        // Only access the random property if it exists
        if ('random' in modelClassConfig && modelClassConfig.random) {
            models = models.sort(() => Math.random() - 0.5);
        }

        // First pass: Try all models checking both API key and quota
        for (const model of models) {
            const provider = getProviderFromModel(model);

            // Check if we have a valid API key and available quota
            if (
                isProviderKeyValid(provider) &&
                quotaManager.hasQuota(provider, model)
            ) {
                console.log(
                    `Using model ${model} from class ${modelGroup} (has API key and quota)`
                );
                return model;
            }
        }

        // Second pass: If we couldn't find a model with quota, just check for API key
        // (This allows exceeding quota when necessary)
        for (const model of models) {
            const provider = getProviderFromModel(model);
            if (isProviderKeyValid(provider)) {
                console.log(
                    `Using model ${model} from class ${modelGroup} (has API key but may exceed quota)`
                );
                return model;
            }
        }
    }

    // If we couldn't find a valid model in the specified class, try the standard class
    if (modelGroup !== 'standard' && 'standard' in MODEL_CLASSES) {
        // Use type assertion to tell TypeScript that 'standard' is a valid key
        const standardModels =
            MODEL_CLASSES['standard' as keyof typeof MODEL_CLASSES].models;

        // First check for models with both API key and quota
        for (const model of standardModels) {
            const provider = getProviderFromModel(model);
            if (
                isProviderKeyValid(provider) &&
                quotaManager.hasQuota(provider, model)
            ) {
                console.log(
                    `Falling back to standard class model ${model} (has API key and quota)`
                );
                return model;
            }
        }

        // Then just check for API key
        for (const model of standardModels) {
            const provider = getProviderFromModel(model);
            if (isProviderKeyValid(provider)) {
                console.log(
                    `Falling back to standard class model ${model} (has API key but may exceed quota)`
                );
                return model;
            }
        }
    }

    // Last resort: return first model in the class, even if we don't have a valid key
    // The provider will handle the error appropriately
    let defaultModel = 'gpt-4.1'; // Fallback if we can't get a model from the class

    // Check if the model group exists in MODEL_CLASSES before trying to access it
    if (modelGroup in MODEL_CLASSES) {
        const models =
            MODEL_CLASSES[modelGroup as keyof typeof MODEL_CLASSES].models;
        if (models.length > 0) {
            defaultModel = models[0];
        }
    }

    console.log(
        `No valid API key found for any model in class ${modelGroup}, using default: ${defaultModel}`
    );
    return defaultModel;
}

/**
 * Get the appropriate model provider based on the model name and class
 * with fallback to OpenRouter if direct provider access isn't available
 */
export function getModelProvider(model?: string): ModelProvider {
    // If no class override, use the model name to determine the provider
    if (model) {
        for (const [prefix, provider] of Object.entries(MODEL_PROVIDER_MAP)) {
            if (
                model.startsWith(prefix) &&
                isProviderKeyValid(getProviderFromModel(model))
            ) {
                return provider;
            }
        }
    }

    // Default to openRouter if no specific provider found
    if (!isProviderKeyValid(getProviderFromModel('openrouter'))) {
        throw new Error(
            `No valid provider found for the model ${model}. Please check your API keys.`
        );
    }
    return openRouterProvider;
}
