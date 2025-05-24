/**
 * Embedding Utilities
 *
 * Utilities for generating and managing text embeddings for vector search.
 * Uses the provider architecture for abstracting away model-specific details.
 */

import {
    getModelFromClass,
    getModelProvider,
} from '../../../ensemble/model_providers/model_provider.js';

// Cache to avoid repeated embedding calls for the same text
const embeddingCache = new Map<
    string,
    {
        embedding: number[];
        timestamp: Date;
    }
>();

/**
 * Generate an embedding vector for the given text
 *
 * @param text Text to embed
 * @param model Optional model override
 * @returns Promise that resolves to a normalized embedding vector
 */
export async function embed(text: string, model?: string): Promise<number[]> {
    // Determine which model to use
    const modelToUse = model || (await getModelFromClass('embedding'));

    // Use a hash of the text and model as the cache key
    const cacheKey = `${modelToUse}:${text}`;

    // Check if we have a cached embedding
    if (embeddingCache.has(cacheKey)) {
        const cached = embeddingCache.get(cacheKey)!;
        console.log(`Using cached embedding for "${text.substring(0, 30)}..."`);
        return cached.embedding;
    }

    // Start timing
    const startTime = Date.now();

    // Get the provider for this model
    const provider = getModelProvider(modelToUse);

    if (!provider.createEmbedding) {
        throw new Error(
            `Provider for model ${modelToUse} does not support embeddings`
        );
    }

    // Generate the embedding using the provider
    const embedding = (await provider.createEmbedding(
        modelToUse,
        text
    )) as number[];

    console.log(
        `Generated embedding for "${text.substring(0, 30)}..." (${Math.round((Date.now() - startTime) / 10) / 100}s) with ${embedding.length} dimensions`
    );

    // Cache the result
    embeddingCache.set(cacheKey, {
        embedding,
        timestamp: new Date(),
    });

    return embedding;
}
