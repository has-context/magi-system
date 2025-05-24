export interface ExtractBase64ImageResult {
    found: boolean;
    originalContent: string;
    replaceContent: string;
    image_id: string | null;
    images: Record<string, string>;
}

export function extractBase64Image(content: string): ExtractBase64ImageResult {
    return {
        found: false,
        originalContent: content,
        replaceContent: content,
        image_id: null,
        images: {},
    };
}

export async function resizeAndSplitForOpenAI(image: string): Promise<string[]> {
    return [image];
}

export async function resizeAndTruncateForClaude(image: string): Promise<string> {
    return image;
}

export async function resizeAndTruncateForGemini(image: string): Promise<string> {
    return image;
}
