import { openaiProvider } from '../../../ensemble/model_providers/openai.js';
import { createToolFunction } from './tool_call.js';
import { ToolFunction, ResponseInput } from '../types/shared-types.js';
import path from 'path';
import { write_file } from './file_utils.js';
import { smart_design_raw } from './design_search.js';
import { getCommunicationManager } from './communication.js';
import { judgeImageSet } from './design/grid_judge.js';
import {
    DESIGN_ASSET_TYPES,
    DESIGN_ASSET_REFERENCE,
    DESIGN_ASSET_GUIDE,
    DesignAssetReferenceItem,
    DesignAssetGuideItem,
    DESIGN_SEARCH_ENGINES,
    DESIGN_SEARCH_DESCRIPTIONS,
    type DesignSpec,
} from './design/constants.js';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createBase64FromImage } from './image_utils.js';
import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import { quick_llm_call } from './llm_call_utils.js';

/**
 * Resize an image to a maximum width of 1536px while maintaining aspect ratio
 * Only resizes if the image is larger than the target width
 *
 * @param base64Image - Base64 encoded image data with data URL prefix
 * @returns Resized base64 image data with data URL prefix
 */
async function resizeImageIfNeeded(base64Image: string): Promise<string> {
    const MAX_WIDTH = 1536;

    // Extract image format and base64 data
    const matches = base64Image.match(
        /^data:image\/([a-zA-Z0-9]+);base64,(.+)$/
    );
    if (!matches) {
        console.warn('Invalid base64 image format');
        return base64Image;
    }

    const imageFormat = matches[1];
    const base64Data = matches[2];

    // Convert base64 to buffer
    const buffer = Buffer.from(base64Data, 'base64');

    // Get image dimensions
    const metadata = await sharp(buffer).metadata();
    const width = metadata.width || 0;

    // If image width is already <= MAX_WIDTH, return original
    if (width <= MAX_WIDTH) {
        return base64Image;
    }

    // Resize the image preserving aspect ratio
    const resizedBuffer = await sharp(buffer)
        .resize({ width: MAX_WIDTH })
        .toFormat(imageFormat as keyof sharp.FormatEnum)
        .toBuffer();

    // Convert back to base64
    const resizedBase64 = resizedBuffer.toString('base64');

    // Return with data URL prefix
    return `data:image/${imageFormat};base64,${resizedBase64}`;
}

/**
 * Generate an image based on a text prompt and save it to a file
 *
 * @param prompt - The text description of the image to generate
 * @param aspect - Optional aspect ratio of the image
 * @param background - Optional background type of the image
 * @param source_images - Optional array of URLs or base64 encoded strings containing images that should be edited or used as reference
 * @param output_path - Optional file path where the image should be saved. If not provided, the image will be saved to a default location.
 * @param number_of_images - Optional number of images to generate (default: 1)
 * @returns A promise that resolves to the path where the image was saved, or an array of paths if multiple images were generated
 */
async function generate_image_raw(
    prompt: string,
    aspect?: 'square' | 'landscape' | 'portrait' | 'auto',
    background?: 'transparent' | 'opaque' | 'auto',
    source_images?: string | string[],
    output_path?: string,
    number_of_images: number = 1,
    quality: 'low' | 'medium' | 'high' | 'auto' = 'medium',
    prefix: string = 'generate'
): Promise<string | string[]> {
    try {
        // Process source images if provided
        let processedImages: string[] | undefined;
        if (source_images && source_images.length > 0) {
            // Convert single image to array for consistent processing
            const imageArray = Array.isArray(source_images)
                ? source_images
                : [source_images];
            processedImages = await Promise.all(
                imageArray.map(async image => {
                    // If it's not a base64 image, convert it
                    if (
                        image.startsWith('http://') ||
                        image.startsWith('https://')
                    ) {
                        // It's a URL, fetch and convert to base64
                        try {
                            const response = await fetch(image);
                            const imageBuffer = Buffer.from(
                                await response.arrayBuffer()
                            );
                            const base64Image =
                                createBase64FromImage(imageBuffer);
                            return await resizeImageIfNeeded(base64Image);
                        } catch (error) {
                            console.error(
                                `Error processing URL image: ${error}`
                            );
                            return image; // Return original URL if processing fails
                        }
                    } else if (image.startsWith('/')) {
                        // It's a local file path, load and convert to base64
                        try {
                            const imageData = await loadImage(image);
                            const canvas = createCanvas(
                                imageData.width,
                                imageData.height
                            );
                            const ctx = canvas.getContext('2d');
                            ctx.drawImage(imageData, 0, 0);
                            const base64Image = canvas.toDataURL('image/png');
                            return await resizeImageIfNeeded(base64Image);
                        } catch (error) {
                            console.error(
                                `Error processing local image: ${error}`
                            );
                            return image; // Return original path if processing fails
                        }
                    } else if (image.startsWith('data:image/')) {
                        // It's already a base64 image, just resize if needed
                        return await resizeImageIfNeeded(image);
                    } else {
                        console.warn(
                            `Unrecognized image format: ${image.substring(0, 20)}...`
                        );
                        return image; // Return as-is if format not recognized
                    }
                })
            );
        }

        // Generate the images using OpenAI API with retry logic
        let imageDataUrls;
        let retryCount = 0;
        const maxRetries = 3;

        while (retryCount < maxRetries) {
            try {
                // Break down the message to avoid ESLint string quote issues
                const retryPrefix =
                    retryCount > 0
                        ? `Retry ${retryCount}/${maxRetries - 1}: `
                        : '';
                console.log(
                    `[ImageAgent] ${retryPrefix}Generating ${number_of_images} image(s) (${quality})`
                );

                imageDataUrls = await openaiProvider.generateImage(
                    prompt,
                    'gpt-image-1',
                    background || 'auto',
                    quality,
                    aspect === 'landscape'
                        ? '1536x1024'
                        : aspect === 'portrait'
                          ? '1024x1536'
                          : aspect === 'auto'
                            ? 'auto'
                            : '1024x1024',
                    processedImages,
                    number_of_images
                );

                // If we reach here, generation was successful
                if (retryCount > 0) {
                    console.log(
                        `[ImageAgent] Successfully generated images after ${retryCount} retry/retries`
                    );
                }
                break;
            } catch (generationError) {
                retryCount++;

                if (retryCount >= maxRetries) {
                    console.error(
                        `[ImageAgent] Failed to generate images after ${maxRetries} attempts:`,
                        generationError
                    );
                    throw new Error(
                        `Failed to generate images after ${maxRetries} attempts: ${generationError.message}`
                    );
                }

                // Log the error and retry
                console.warn(
                    `[ImageAgent] Error during image generation (attempt ${retryCount}/${maxRetries}):`,
                    generationError
                );
                console.log('[ImageAgent] Retrying in 2 seconds...');

                // Wait for 2 seconds before retrying
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        // If we got here without imageDataUrls, something went wrong
        if (!imageDataUrls) {
            throw new Error(
                '[ImageAgent] Failed to generate images - no data URLs returned'
            );
        }

        // Get timestamp once for all images
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filePaths: string[] = [];

        // Process each image data URL
        for (let i = 0; i < imageDataUrls.length; i++) {
            const imageDataUrl = imageDataUrls[i];

            // Extract the base64 data (remove the data URL prefix)
            const base64Data = imageDataUrl.replace(
                /^data:image\/png;base64,/,
                ''
            );

            // Convert base64 to buffer
            const imageBuffer = Buffer.from(base64Data, 'base64');

            // Determine the target file path for this image
            let targetPath = output_path;
            if (!targetPath) {
                // Use the default location in the output directory
                const fileName =
                    number_of_images === 1
                        ? `${prefix}_image_${timestamp}.png`
                        : `${prefix}_image_${timestamp}_${i + 1}.png`;
                targetPath = path.join(
                    '/magi_output/shared/generate_image',
                    fileName
                );
            } else if (number_of_images > 1) {
                // If output_path was provided, append index for multiple images
                const pathParts = output_path.split('.');
                if (pathParts.length > 1) {
                    // Insert index before file extension
                    pathParts[pathParts.length - 2] += `_${i + 1}`;
                    targetPath = pathParts.join('.');
                } else {
                    // No extension, just append index
                    targetPath += `_${i + 1}`;
                }
            }

            write_file(targetPath, imageBuffer.buffer);
            filePaths.push(targetPath);

            const comm = getCommunicationManager();
            comm.send({
                type: 'design',
                data: imageDataUrl,
                timestamp: new Date().toISOString(),
                prompt,
            });
        }

        // Return a single path or array of paths based on number_of_images
        return number_of_images === 1 ? filePaths[0] : filePaths;
    } catch (error) {
        console.error('[ImageAgent] Error generating image:', error);
        throw error;
    }
}
/**
 * Wrapper for generate_image that ensures a string return type for tool compatibility
 */
async function generate_image(
    prompt: string,
    aspect?: 'square' | 'landscape' | 'portrait' | 'auto',
    background?: 'transparent' | 'opaque' | 'auto',
    source_images?: string | string[],
    output_path?: string,
    number_of_images?: number
): Promise<string> {
    const result = await generate_image_raw(
        prompt,
        aspect,
        background,
        source_images,
        output_path,
        number_of_images
    );

    // If we got an array of paths, join them with commas for the tool output
    if (Array.isArray(result)) {
        return result.join(', ');
    }

    return result;
}

/**
 * Get all file tools as an array of tool definitions
 */
export function getImageGenerationTools(): ToolFunction[] {
    return [
        createToolFunction(
            generate_image, // Use the wrapper function that always returns a string
            'Generate or edit an image based on a textual description. Uses high-quality image generation models. Please note that image generation may take several minutes.',
            {
                prompt: 'A text description of the desired image',
                aspect: {
                    description: 'The aspect ratio of the image',
                    type: 'string',
                    enum: ['square', 'landscape', 'portrait', 'auto'],
                    default: 'auto',
                },
                background: {
                    description: 'The background type of the image',
                    type: 'string',
                    enum: ['transparent', 'opaque', 'auto'],
                    default: 'auto',
                },
                source_images: {
                    description:
                        'A URL or base64 encoded string or array of images that should be edited or used as references',
                    optional: true,
                },
                output_path: {
                    description:
                        'Destination file path for the generated PNG. If omitted, the file is saved to /magi_output/shared/generate_image/ with a timestamp.',
                    optional: true,
                },
                number_of_images: {
                    description:
                        'Number of images to generate (default: 1). Returns a comma-separated list of file paths if > 1.',
                    type: 'number',
                    default: 1,
                    optional: true,
                },
            }
        ),
    ];
}

/**
 * Get design specifications from the LLM based on the user prompt
 *
 * @param userPrompt - The original design prompt from the user
 * @returns A promise that resolves to design specifications
 */
async function get_design_spec(
    type: DESIGN_ASSET_TYPES,
    userPrompt: string,
    reference: DesignAssetReferenceItem,
    guide: DesignAssetGuideItem,
    brand_assets: string[] = []
): Promise<DesignSpec> {
    console.log(
        `[design_image] Getting design specification for: "${userPrompt}"`
    );

    const readableType = type.replace(/_/g, ' ');
    const readableName = reference.name.toLowerCase();

    const input: ResponseInput = [
        {
            type: 'message',
            role: 'system',
            content: `### RESEARCH

We have performed research on the best practices for designing a ${readableType}

SPECIFICATIONS:
- aspect ratio: ${reference.spec.aspect}
- background: ${reference.spec.background}

GENERAL GUIDELINES:
- ${guide.guide.join('\n- ')}

IDEAL CHARACTERISTICS:
- ${guide.ideal.join('\n- ')}

WARNINGS:
- ${guide.warnings.join('\n- ')}

INSPIRATION:
- ${guide.inspiration.join('\n- ')}

JUDGING CRITERIA:
- ${guide.criteria.join('\n- ')}`,
        },
        {
            type: 'message',
            role: 'user',
            content:
                'DESIGN REQUEST: ' +
                userPrompt +
                (brand_assets.length
                    ? `\n\nExisting brand assets provided for style reference:\n${brand_assets
                          .map(b => path.basename(b))
                          .join(', ')}`
                    : ''),
        },
    ];

    try {
        const raw = await quick_llm_call(input, 'reasoning', {
            name: 'DesignSpecAgent',
            description: 'Generate design spec parameters',
            instructions: `You are a **Design Specification Agent**. Your role is to translate a design brief into the optimal JSON specification for an automated, multi-round design pipeline.

You are helping to create a **${readableName}** (${reference.description}) that will be used for “${reference.usage_context}”.

DESIGN PIPELINE:
1. **Inspiration Search** - query multiple design-search engines for reference imagery that fits the brief (you will output these queries).
2. **Inspiration Curation** - we filter down to the best images.
3. **Round 1 - Drafts**
    • Engine uses multiple versions of \`design_prompts.draft\` to render MANY low-res concepts.
    • \`design_judge.draft\` scores them; minor typos & imperfections are acceptable.
4. **Round 2 - Medium Upscale**
    • Best draft is recreated with more detail using \`design_prompts.medium\`.
    • Must FIX spelling/kerning; PRESERVE general layout & palette. Improve detail.
    • \`design_judge.medium\` verifies: layout locked, no typos for most assets (mockups ok), small artifacts OK.
5. **Round 3 - High Upscale (Final)**
    • Medium image is upscaled to final version with \`design_prompts.high\`.
    • Must achieve pixel-perfect fidelity: exact colors, alignment, WCAG-AA.
    • \`design_judge.high\` is validates we have a valid outcome; any failure triggers up to 2 re-attempts.

Typos should be fixed in medium and high version of most assets, but not for mockups. Mockups will be converted to HTML and the text will be rendered in the browser, so typos and imperfections in the content which will be replaced by the browser are acceptable.

YOUR TASK:
1. **Analyze INTENT** - read the DESIGN REQUEST and the preceding RESEARCH (specs, guidelines, ideals, warnings, inspiration, judging criteria).
2. **Populate every JSON field** in the provided schema *step by step*

Return **valid JSON** that matches the \`design_specification\` schema.
`,
            modelSettings: {
                force_json: true,
                json_schema: {
                    name: 'design_specification',
                    type: 'json_schema',
                    schema: {
                        type: 'object',
                        properties: {
                            run_id: {
                                type: 'string',
                                description:
                                    'A snake_case identifier for this design run based on the prompt.',
                            },
                            context: {
                                type: 'string',
                                description:
                                    'Explain what it is we are creating. This will be passed to all agents in the pipeline so they understand the task and goals.',
                            },
                            aspect: {
                                description: 'Aspect ratio of the design',
                                type: 'string',
                                enum: ['square', 'landscape', 'portrait'],
                            },
                            background: {
                                description:
                                    'Should the background be transparent or opaque?',
                                type: 'string',
                                enum: ['transparent', 'opaque'],
                            },
                            inspiration_search: {
                                type: 'array',
                                description:
                                    'Find reference images for the design. Create searches tailored to design request and design engine. Each query should be brief (think typed in the search bar on the site). Provide multiple queries for the same engine if very relevant, or leave out an engine if not. But try to balance to get a good variety of results. Aim for around 6-10 searches in total.',
                                items: {
                                    type: 'object',
                                    properties: {
                                        engine: {
                                            type: 'string',
                                            enum: DESIGN_SEARCH_ENGINES,
                                            description: `Design search engine to use:\n${DESIGN_SEARCH_DESCRIPTIONS.join('\n')}`,
                                        },
                                        query: {
                                            type: 'string',
                                            description:
                                                'Search query for this specific engine',
                                        },
                                    },
                                    additionalProperties: false,
                                    required: ['engine', 'query'],
                                },
                            },
                            inspiration_judge: {
                                description:
                                    'What should we look for when narrowing down the inspiration images? Use the research provided and the design request to construct a guide for comparing multiple inspiration images as to which is the most relevant. This should be about a paragraph long.',
                                type: 'string',
                            },
                            design_prompts: {
                                type: 'object',
                                description: `
Once we have collected a number of inspiration images, we will use this prompt to generate a new design based on them. It should condense the research and design request into a prompt for each stage.

• **draft**  - *ARRAY of exactly 3* one-paragraph prompts, each exploring the brief from a different creative angle. Focus on providing guidance for the design process, not exact details of the final product. However include any specific details from in the original design request. Each brief should highlight a specific part of the design process, but all should include everything needed by the agent to produce an amazing design.
• **medium** - ONE paragraph. Preserve layout & palette of the chosen draft, fix typos (unless mockup), improve detail.
• **high**   - ONE paragraph. Final fidelity, brand-exact colors/fonts, remove all artifacts, fully pixel-perfect.

Each paragraph must be plain-text, no markdown.`,
                                properties: {
                                    draft: {
                                        type: 'array',
                                        minItems: 3,
                                        maxItems: 3,
                                        items: { type: 'string' },
                                    },
                                    medium: { type: 'string' },
                                    high: { type: 'string' },
                                },
                                required: ['draft', 'medium', 'high'],
                            },
                            design_judge: {
                                type: 'object',
                                description: `
Each field is ONE paragraph that downstream code parses for Pass/Fail.

Draft • Focus on CONCEPT viability
- Accept minor text errors or grain
- Reject off-brand colors, unreadable copy, chaotic layout

Medium • Focus on composition
- Accept tiny pixel noise
- Reject any errors, layout shift, brand-color drift
- For mockups, spelling errors and placeholder text is acceptable

High • Focus on polish
- Reject on ANY color mismatch, mis-alignment, WCAG-AA failure
- For mockups, spelling errors and placeholder text is acceptable
                                `,
                                properties: {
                                    draft: { type: 'string' },
                                    medium: { type: 'string' },
                                    high: { type: 'string' },
                                },
                                required: ['draft', 'medium', 'high'],
                            },
                        },
                        additionalProperties: false,
                        required: [
                            'aspect',
                            'background',
                            'inspiration_search',
                            'inspiration_judge',
                            'design_prompts',
                            'design_judge',
                        ],
                    },
                },
            },
        });

        return JSON.parse(raw);
    } catch (error) {
        console.error(`[design_image] Error getting design spec: ${error}`);

        throw error;
    }
}

/**
 * Type alias for design phases
 */
type JudgePhase = 'draft' | 'medium' | 'high';

/**
 * Helper to generate images with consistent parameters
 */
async function genImages(
    prompt: string,
    aspect: string,
    background: string,
    references: string | string[] | undefined,
    count: number,
    quality: 'low' | 'medium' | 'high',
    prefix: string
): Promise<string[]> {
    const result = await generate_image_raw(
        prompt,
        aspect as any,
        background as any,
        references,
        undefined, // No output path
        count,
        quality,
        prefix + '_' + quality
    );

    return Array.isArray(result) ? result : [result];
}

/**
 * Run iterative selection to narrow down candidates
 */
async function iterativeSelect(
    candidates: string[],
    targetCount: number,
    phase: JudgePhase,
    prompt: string,
    type: DESIGN_ASSET_TYPES,
    judgeSpec: string,
    prefix: string
): Promise<string[]> {
    console.log(
        `[design_image] Selecting ${targetCount} best ${phase} images from ${candidates.length} candidates`,
        judgeSpec
    );

    let round = 1;
    let currentCandidates = [...candidates];
    const processedIds = new Set<string>();

    // Run selection rounds until we reach target count
    while (currentCandidates.length > targetCount) {
        console.log(
            `[design_image] ${phase} selection round ${round}: Processing ${currentCandidates.length} candidates`,
            judgeSpec
        );

        // Use judgeImageSet to select best images from all candidates
        const selected = await judgeImageSet<string>({
            items: currentCandidates,
            prompt,
            selectLimit: targetCount,
            processedIds,
            getId: (item: string) => item,
            toImageSource: (item: string) => ({ url: item }),
            gridName: `${prefix}_grid_${phase}_${round}`,
            isDesignSearch: false,
            type,
            judgeGuide: judgeSpec,
        });

        // If no images were selected, break and use first candidate
        if (selected.length === 0) {
            if (currentCandidates.length > 0) {
                currentCandidates = [currentCandidates[0]];
            }
            break;
        }

        // Update candidates for next round
        currentCandidates = selected;
        round++;

        // Safety: if we've gone through too many rounds, just pick the best we have
        if (round > 5) {
            console.log(
                `[design_image] Reached maximum ${phase} rounds (5), using best candidates so far`
            );
            break;
        }
    }

    // Return up to targetCount candidates
    return currentCandidates.slice(0, targetCount);
}

/**
 * High level design search with iterative vision-based ranking to generate an enhanced image
 */
export async function design_image(
    type: DESIGN_ASSET_TYPES,
    prompt: string,
    with_inspiration: boolean = true,
    brand_assets: string[] = []
): Promise<string> {
    const sessionId = uuidv4().substring(0, 8);
    const reference = DESIGN_ASSET_REFERENCE[type];
    const guide = DESIGN_ASSET_GUIDE[type];

    // Step 0: Ask the LLM for design specification
    const spec = await get_design_spec(
        type,
        prompt,
        reference,
        guide,
        brand_assets
    );
    console.log(
        `[design_image] Design spec for "${prompt}":`,
        JSON.stringify(spec, null, 2)
    );

    // Set up parallel generation batches
    console.log('[design_image] Starting draft phase');

    // Get draft prompts from the design spec
    const draftPrompts = spec.design_prompts.draft;
    const referenceInstruction =
        '\n\nPlease use the reference images provided as inspiration only. Do not copy them or use them directly in your design. You are creating a new design based on the style from these images.';

    try {
        //
        // DRAFT PHASE
        //

        // Generate images without references for each draft prompt (3×3=9)
        console.log(
            '[design_image] Generating draft images without references'
        );
        const noRefPromises = draftPrompts.map((draftPrompt, i) => {
            console.log(
                `[design_image] Queueing draft batch ${i + 1}/${draftPrompts.length}: without references`,
                draftPrompt
            );
            return genImages(
                spec.context + '\n\n' + draftPrompt,
                spec.aspect,
                spec.background,
                undefined,
                3,
                'low',
                spec.run_id + '_' + sessionId
            );
        });

        // Collect reference images if requested
        let withRefPromises: Promise<string[]>[] = [];
        if (with_inspiration) {
            console.log(
                '[design_image] Searching for reference designs',
                spec.inspiration_search
            );
            const designs = await smart_design_raw(
                spec.inspiration_search,
                3,
                type,
                spec.context + '\n\n' + spec.inspiration_judge,
                spec.run_id + '_' + sessionId
            );
            console.log(
                `[design_image] Found ${designs.length} reference designs`
            );

            // Extract image URLs to use as reference
            const referenceImages = designs
                .filter(design => design.screenshotURL)
                .map(design => design.screenshotURL as string);

            if (referenceImages.length > 0) {
                // Generate images with references for each draft prompt (3×9=27 more)
                console.log(
                    '[design_image] Generating draft images with references'
                );
                withRefPromises = draftPrompts.map((draftPrompt, i) => {
                    console.log(
                        `[design_image] Queueing draft batch ${i + 1 + draftPrompts.length}/${draftPrompts.length * 2}: with references`,
                        draftPrompt + referenceInstruction
                    );
                    return genImages(
                        spec.context +
                            '\n\n' +
                            draftPrompt +
                            referenceInstruction,
                        spec.aspect,
                        spec.background,
                        referenceImages,
                        3,
                        'low',
                        spec.run_id + '_' + sessionId + '_ref'
                    );
                });
            }
        }

        // Wait for all generation promises to complete in parallel
        console.log('[design_image] Waiting for draft batches to complete...');
        const allBatchResults = await Promise.all([
            ...noRefPromises,
            ...withRefPromises,
        ]);

        // Flatten the results into a single array of image paths
        const allDraftImagePaths = allBatchResults.flat();
        console.log(
            `[design_image] Generated ${allDraftImagePaths.length} total draft variations`
        );

        // STEP 2: Use iterative selection to find top 3 drafts
        const bestDraftPaths = await iterativeSelect(
            allDraftImagePaths,
            3, // Keep top 3 for medium phase
            'draft',
            prompt,
            type,
            spec.context + '\n\n' + spec.design_judge.draft,
            spec.run_id + '_' + sessionId
        );

        console.log(`[design_image] Selected ${bestDraftPaths.length} best drafts for medium phase:
        ${bestDraftPaths.join('\n        ')}`);

        //
        // MEDIUM PHASE
        //

        // STEP 3: Generate medium quality versions of each selected draft
        console.log('[design_image] Starting medium quality phase');

        // Generate 3 medium images for each of the 3 best drafts (3×3=9)
        const mediumPromises = bestDraftPaths.map((draftPath, i) => {
            console.log(
                `[design_image] Generating medium quality batch ${i + 1}/${bestDraftPaths.length} from draft`
            );
            return genImages(
                spec.context + '\n\n' + spec.design_prompts.medium,
                spec.aspect,
                spec.background,
                draftPath,
                3, // 3 medium images per draft
                'medium',
                spec.run_id + '_' + sessionId
            );
        });

        // Wait for all medium generation to complete
        const mediumBatches = await Promise.all(mediumPromises);
        const allMediumPaths = mediumBatches.flat();

        console.log(
            `[design_image] Generated ${allMediumPaths.length} medium-quality images`
        );

        // STEP 4: Select best medium image using medium judge
        const mediumProcessedIds = new Set<string>();
        const bestMediumPaths = await judgeImageSet<string>({
            items: allMediumPaths,
            prompt,
            selectLimit: 1,
            processedIds: mediumProcessedIds,
            getId: (item: string) => item,
            toImageSource: (item: string) => ({ url: item }),
            gridName: 'medium_all',
            isDesignSearch: false,
            type,
            judgeGuide: spec.context + '\n\n' + spec.design_judge.medium,
        });

        if (bestMediumPaths.length === 0) {
            throw new Error('[design_image] No medium images selected');
        }

        const bestMediumPath = bestMediumPaths[0];
        console.log(
            `[design_image] Selected best medium-quality image: ${bestMediumPath}`
        );

        //
        // HIGH PHASE
        //

        // STEP 5: Generate high quality version with retry logic
        console.log(
            '[design_image] Starting high-quality generation with retry logic'
        );

        return await upscaleHighWithRetry(
            bestMediumPath,
            spec.context + '\n\n' + spec.design_prompts.high,
            spec.context + '\n\n' + spec.design_judge.high,
            spec.aspect,
            spec.background
        );
    } catch (error) {
        console.error(
            '[design_image] Error during image selection or generation:',
            error
        );

        throw error;
    }
}

/**
 * Check if the high quality image passes the specified criteria
 */
async function checkHighQualityPass(
    imagePath: string,
    criteria: string
): Promise<boolean> {
    try {
        // Query LLM to evaluate the image based on criteria
        const input: ResponseInput = [
            {
                type: 'message',
                role: 'system',
                content: `Evaluate if the following image at ${imagePath} meets these criteria:
${criteria}

Return EXACTLY "PASS" if it meets the criteria or "FAIL" if it doesn't.`,
            },
        ];

        const response = await quick_llm_call(input, 'reasoning', {
            name: 'HighQualityImageJudge',
            description: 'Evaluate image quality against specified criteria',
            instructions: `You are a **Quality Assurance Judge** for AI-generated images. Your task is to evaluate if an image meets the specified high-quality criteria.

Examine the image carefully and assess if it meets ALL the criteria provided. Be strict and thorough in your assessment.

Response Rules:
- Return EXACTLY "PASS" if the image fully meets ALL criteria
- Return EXACTLY "FAIL" if the image fails to meet ANY of the criteria
- No explanations, just PASS or FAIL`,
            modelSettings: {
                max_tokens: 10, // Just need "PASS" or "FAIL"
            },
        });

        const verdict = response.trim().toUpperCase();
        console.log(`[design_image] High quality check verdict: ${verdict}`);
        return verdict === 'PASS';
    } catch (error) {
        console.error(
            `[design_image] Error during high quality check: ${error}`
        );
        return false; // Assume failure if we couldn't complete the check
    }
}

/**
 * Generate a high-quality version of an image with retry logic
 */
async function upscaleHighWithRetry(
    sourcePath: string,
    highPrompt: string,
    highCriteria: string,
    aspect?: 'square' | 'landscape' | 'portrait' | 'auto',
    background?: 'transparent' | 'opaque' | 'auto'
): Promise<string> {
    let lastImagePath = sourcePath;

    // Try up to 3 times to generate a high-quality image that passes checks
    for (let attempt = 1; attempt <= 3; attempt++) {
        console.log(
            `[design_image] High quality generation attempt ${attempt}/3`
        );

        const highResult = await generate_image_raw(
            highPrompt,
            aspect,
            background,
            lastImagePath,
            undefined,
            1,
            'high'
        );

        let highImagePath: string;
        if (typeof highResult === 'string') {
            highImagePath = highResult;
        } else if (Array.isArray(highResult) && highResult.length > 0) {
            highImagePath = highResult[0];
        } else {
            throw new Error(
                '[design_image] High-quality generation returned no valid image'
            );
        }

        console.log(
            `[design_image] Generated high-quality image: ${highImagePath}`
        );

        // Check if the image passes the high quality criteria
        const passes = await checkHighQualityPass(highImagePath, highCriteria);

        if (passes) {
            console.log(
                '[design_image] High quality image PASSED quality check'
            );
            return highImagePath;
        }

        console.log(
            `[design_image] High quality image FAILED quality check (attempt ${attempt}/3)`
        );

        // Use this image as the source for the next attempt
        lastImagePath = highImagePath;
    }

    // If we've exhausted all retry attempts, return the last generated image
    console.log(
        '[design_image] Exhausted retry attempts, returning best effort high quality image'
    );
    return lastImagePath;
}

export function getDesignImageTools() {
    return [
        createToolFunction(
            design_image,
            'An intelligent process that searches the web for reference images, then runs multiple passes to generate aesthetically pleasing designs. Can be used to design logos, websites, and other visual content.',
            {
                type: {
                    description: 'What type of design to create',
                    type: 'string',
                    enum: ['color_pallet', 'primary_logo', 'homepage_mockup'],
                    default: 'primary_logo',
                },
                prompt: 'A text description of the desired design',
                with_inspiration: {
                    description:
                        'The design process will look at reference images from the web to help inspire the design. This will take longer, but the results are usually significantly better.',
                    type: 'boolean',
                    default: 'true',
                },
                brand_assets: {
                    description:
                        'Optional array of existing brand asset file paths to maintain style consistency',
                    type: 'array',
                    optional: true,
                },
            }
        ),
    ];
}
