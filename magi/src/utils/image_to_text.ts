/**
 * Image to text conversion utility functions.
 *
 * This module provides utilities for converting images to textual descriptions
 * using the Claude API for models that don't support image input.
 */

import Anthropic from '@anthropic-ai/sdk';
import { findModel } from '../../../ensemble/model_providers/model_data.js';

// Define the types we need based on the Anthropic SDK structure
type TextBlock = {
    type: 'text';
    text: string;
};

type ImageBlock = {
    type: 'image';
    source: {
        type: 'base64';
        media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
        data: string;
    };
};

type MessageContent = TextBlock | ImageBlock;

type Message = {
    role: 'user' | 'assistant' | 'system';
    content: MessageContent[];
};

// Cache for image descriptions
interface ImageDescriptionCache {
    [imageHash: string]: string;
}

// In-memory cache for image descriptions
const imageDescriptionCache: ImageDescriptionCache = {};

/**
 * Generate a hash for an image to use as a cache key
 *
 * @param imageData - Base64 encoded image data
 * @returns A string hash that can be used as a cache key
 */
function generateImageHash(imageData: string): string {
    // Simple hash function for cache key - using first 100 chars + length should be sufficient
    // for our needs while being much faster than a full hash
    const sample = imageData.substring(0, 100);
    const length = imageData.length;
    return `${sample}_${length}`;
}

/**
 * Converts an image to a text description
 * Uses Claude API directly and caches the results
 *
 * @param imageData - Base64 encoded image data
 * @param modelId - ID of the model being used (for logging)
 * @returns The image description
 */
export async function convertImageToText(
    imageData: string,
    modelId: string
): Promise<string> {
    // Skip if not an image
    if (!imageData.startsWith('data:image/')) {
        return imageData;
    }

    console.log(`Converting image to text description for model ${modelId}`);

    // Generate hash for caching
    const imageHash = generateImageHash(imageData);

    // Check cache
    if (imageDescriptionCache[imageHash]) {
        console.log(`Using cached image description for ${modelId}`);
        return imageDescriptionCache[imageHash];
    }

    // Use Claude to describe the image
    try {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
            throw new Error('ANTHROPIC_API_KEY not set');
        }

        const anthropic = new Anthropic({
            apiKey,
        });

        // Use a simplified approach to directly ask Claude to describe the image
        const prompt =
            'Please describe this image in a few sentences. Focus on the main visual elements and key details that someone would need to understand what is shown in the image.';

        // Get the media type from the image data
        const mediaType = (
            imageData.includes('data:image/jpeg')
                ? 'image/jpeg'
                : imageData.includes('data:image/png')
                  ? 'image/png'
                  : imageData.includes('data:image/gif')
                    ? 'image/gif'
                    : imageData.includes('data:image/webp')
                      ? 'image/webp'
                      : 'image/jpeg'
        ) as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

        // Create properly typed content blocks
        const textBlock: TextBlock = {
            type: 'text',
            text: prompt,
        };

        const imageBlock: ImageBlock = {
            type: 'image',
            source: {
                type: 'base64',
                media_type: mediaType,
                data: imageData.replace(/^data:image\/[a-z]+;base64,/, ''),
            },
        };

        // Create a properly typed message
        const messages: Message[] = [
            {
                role: 'user',
                content: [textBlock, imageBlock],
            },
        ];

        // Use claude-3-5-haiku-latest as our image-to-text model for efficiency
        // Cast to any to bypass type checking since we know the structure is correct
        const response = await anthropic.messages.create({
            model: 'claude-3-5-haiku-latest',
            messages: messages as any,
            max_tokens: 1000,
        });

        // Get the description from the response
        const description = response.content?.[0]?.text || '';

        // Format the result
        const formattedDescription = `[Image description: ${description.trim()}]`;

        // Cache the result
        imageDescriptionCache[imageHash] = formattedDescription;

        console.log('Generated new image description and cached it');
        return formattedDescription;
    } catch (error) {
        console.error('Error generating image description:', error);
        return '[Image could not be processed]';
    }
}

/**
 * Converts an image to a text description if the model doesn't support image input
 * Uses the image-to-text API and caches the results
 *
 * @param imageData - Base64 encoded image data
 * @param modelId - ID of the model being used
 * @param modelSupportsImages - Function that returns true if the model supports images
 * @returns The image description or original image data if model supports images
 */
export async function convertImageToTextIfNeeded(
    imageData: string,
    modelId: string
): Promise<string> {
    // Skip if not an image
    if (!imageData.startsWith('data:image/')) {
        return imageData;
    }

    // Check if model supports image input
    if (findModel(modelId)?.features?.input_modality?.includes('image')) {
        // Model supports images, return original
        return imageData;
    }

    // Convert to text description
    return await convertImageToText(imageData, modelId);
}
