/**
 * Cost tracking module for the MAGI system.
 *
 * Tracks costs across all model providers and provides reporting functions.
 * Integrates with quota management to track usage against free tiers and rate limits.
 */
import {
    findModel,
    ModelUsage,
    TieredPrice,
    TimeBasedPrice,
} from '../../../ensemble/model_providers/model_data.js';
import { CostUpdateEvent } from '../types/shared-types.js';
import { sendStreamEvent } from './communication.js';
import { quotaManager } from './quota_manager.js';
import { getProviderFromModel } from '../../../ensemble/model_providers/model_provider.js';

/**
 * Singleton class to track costs across all model providers
 */
class CostTracker {
    private entries: ModelUsage[] = [];
    private started: Date = new Date();

    /**
     * Calculates the cost for a given model usage instance based on registry data.
     * Handles tiered pricing and free tier flags.
     *
     * @param usage - The ModelUsage object containing token counts and model ID.
     * @returns The updated ModelUsage object with the calculated cost.
     * @throws Error if the model specified in usage is not found in the registry.
     */
    calculateCost(usage: ModelUsage): ModelUsage {
        // If cost is already calculated or explicitly set to 0, return early.
        if (typeof usage.cost === 'number') {
            return usage;
        }

        // Check if this specific usage instance falls under a free tier quota.
        if (usage.isFreeTierUsage) {
            usage.cost = 0;
            return usage;
        }

        const model = findModel(usage.model);
        if (!model) {
            console.error(
                `Model not found when recording usage: ${usage.model}`
            );
            throw new Error(
                `Model not found when recording usage: ${usage.model}`
            );
        }

        // Initialize cost
        usage.cost = 0;

        // Get token counts, defaulting to 0 if undefined
        // Unused: const input_tokens = usage.input_tokens || 0; // This will be adjusted for cache hits later
        const original_input_tokens = usage.input_tokens || 0; // Keep original count for potential tier checks
        const output_tokens = usage.output_tokens || 0;
        const cached_tokens = usage.cached_tokens || 0;
        const image_count = usage.image_count || 0; // For per-image models

        // Use provided timestamp, or current time (with warning) if needed for time-based pricing
        const calculationTime = usage.timestamp || new Date();
        // Unused: let timestampWarningIssued = false;
        // Check if any cost component uses time-based pricing
        const usesTimeBasedPricing =
            (typeof model.cost?.input_per_million === 'object' &&
                model.cost.input_per_million !== null &&
                'peak_price_per_million' in model.cost.input_per_million) ||
            (typeof model.cost?.output_per_million === 'object' &&
                model.cost.output_per_million !== null &&
                'peak_price_per_million' in model.cost.output_per_million) ||
            (typeof model.cost?.cached_input_per_million === 'object' &&
                model.cost.cached_input_per_million !== null &&
                'peak_price_per_million' in
                    model.cost.cached_input_per_million);

        if (!usage.timestamp && usesTimeBasedPricing) {
            console.warn(
                `Timestamp missing for time-based pricing model '${usage.model}'. Defaulting to current time for calculation.`
            );
            // Unused: timestampWarningIssued = true; // Avoid repeated warnings in helper
        }

        // --- Helper function to get price per million based on token count and cost structure ---
        const getPrice = (
            tokensForTierCheck: number, // Use relevant token count (e.g., original input, output, cached) for tier checks
            costStructure: number | TieredPrice | TimeBasedPrice | undefined
        ): number => {
            if (typeof costStructure === 'number') {
                // --- Flat Rate ---
                return costStructure;
            }

            if (typeof costStructure === 'object' && costStructure !== null) {
                if ('peak_price_per_million' in costStructure) {
                    // --- Time-Based Pricing ---
                    const timeBasedCost = costStructure as TimeBasedPrice;
                    const utcHour = calculationTime.getUTCHours();
                    const utcMinute = calculationTime.getUTCMinutes();
                    const currentTimeInMinutes = utcHour * 60 + utcMinute;
                    const peakStartInMinutes =
                        timeBasedCost.peak_utc_start_hour * 60 +
                        timeBasedCost.peak_utc_start_minute;
                    const peakEndInMinutes =
                        timeBasedCost.peak_utc_end_hour * 60 +
                        timeBasedCost.peak_utc_end_minute;

                    let isPeakTime: boolean;
                    // Check if the peak window crosses midnight UTC
                    if (peakStartInMinutes <= peakEndInMinutes) {
                        // Peak window does not cross midnight UTC (e.g., 00:30 to 16:30)
                        isPeakTime =
                            currentTimeInMinutes >= peakStartInMinutes &&
                            currentTimeInMinutes < peakEndInMinutes;
                    } else {
                        // Peak window crosses midnight UTC (e.g., peak is 22:00 to 06:00)
                        isPeakTime =
                            currentTimeInMinutes >= peakStartInMinutes ||
                            currentTimeInMinutes < peakEndInMinutes;
                    }

                    return isPeakTime
                        ? timeBasedCost.peak_price_per_million
                        : timeBasedCost.off_peak_price_per_million;
                } else if ('threshold_tokens' in costStructure) {
                    // --- Token-Based Tiered Pricing ---
                    const tieredCost = costStructure as TieredPrice;
                    // Use the token count passed for tier checking
                    if (tokensForTierCheck <= tieredCost.threshold_tokens) {
                        return tieredCost.price_below_threshold_per_million;
                    } else {
                        return tieredCost.price_above_threshold_per_million;
                    }
                }
            }
            return 0; // No cost defined or invalid structure
        };

        // --- Handle Token Cost Calculation ---

        // Determine how many input tokens are non-cached vs cached based on whether a distinct cached cost exists
        let nonCachedInputTokens = 0;
        let actualCachedTokens = 0; // Tokens that will be billed at the specific cached rate

        if (
            cached_tokens > 0 &&
            model.cost?.cached_input_per_million !== undefined
        ) {
            // If there's a specific cost defined for cached tokens (even if it's 0 or complex), calculate them separately.
            actualCachedTokens = cached_tokens;
            nonCachedInputTokens = Math.max(
                0,
                original_input_tokens - cached_tokens
            ); // Remaining input billed normally
        } else {
            // If no specific cached cost structure is defined in the registry, all input tokens are billed at the standard input rate.
            nonCachedInputTokens = original_input_tokens;
            actualCachedTokens = 0; // No tokens billed at a special cached rate
        }

        // Calculate Input Token Cost (Non-Cached Part)
        if (
            nonCachedInputTokens > 0 &&
            model.cost?.input_per_million !== undefined
        ) {
            // Use original_input_tokens for tier check if input cost is tiered
            const inputPricePerMillion = getPrice(
                original_input_tokens,
                model.cost.input_per_million
            );
            usage.cost +=
                (nonCachedInputTokens / 1000000) * inputPricePerMillion;
        }

        // Calculate Cached Token Cost (If applicable and cost defined)
        if (
            actualCachedTokens > 0 &&
            model.cost?.cached_input_per_million !== undefined
        ) {
            // Use actualCachedTokens (i.e., usage.cached_tokens) for tier check if cached cost is tiered
            const cachedPricePerMillion = getPrice(
                actualCachedTokens,
                model.cost.cached_input_per_million
            );
            usage.cost +=
                (actualCachedTokens / 1000000) * cachedPricePerMillion;
        }

        // Calculate Output Token Cost
        if (output_tokens > 0 && model.cost?.output_per_million !== undefined) {
            // Use output_tokens for tier check if output cost is tiered
            const outputPricePerMillion = getPrice(
                output_tokens,
                model.cost.output_per_million
            );
            usage.cost += (output_tokens / 1000000) * outputPricePerMillion;
        }

        // --- Handle Per-Image Cost Calculation ---
        if (image_count > 0 && model.cost?.per_image) {
            usage.cost += image_count * model.cost.per_image;
        }

        // Ensure cost is not negative
        usage.cost = Math.max(0, usage.cost);

        return usage;
    }

    /**
     * Record usage details from a model provider
     *
     * @param usage ModelUsage object containing the cost and usage details
     */
    addUsage(usage: ModelUsage): void {
        try {
            // Calculate cost if not already set
            usage = this.calculateCost({ ...usage });
            usage.timestamp = new Date();

            // Track quota usage with the quota manager
            try {
                const provider = getProviderFromModel(usage.model);
                const inputTokens = usage.input_tokens || 0;
                const outputTokens = usage.output_tokens || 0;

                // Track this usage against provider quotas
                quotaManager.trackUsage(
                    provider,
                    usage.model,
                    inputTokens,
                    outputTokens
                );

                // Track credit usage for paid providers
                if (usage.cost && usage.cost > 0) {
                    quotaManager.trackCreditUsage(provider, usage.cost);
                }

                // Include quota information in cost update event
                const quotaSummary = quotaManager.getSummary();
                if (quotaSummary[provider]) {
                    if (!usage.metadata) {
                        usage.metadata = {};
                    }
                    usage.metadata.quota = quotaSummary[provider];
                }
            } catch (quotaError) {
                console.error('Error tracking quota usage:', quotaError);
            }

            // Add to entries list
            this.entries.push(usage);

            // Send the cost data
            const costEvent: CostUpdateEvent = {
                type: 'cost_update',
                usage,
            };
            sendStreamEvent(costEvent);
        } catch (err) {
            console.error('Error recording usage:', err);
        }
    }

    /**
     * Get total cost across all providers
     */
    getTotalCost(): number {
        return this.entries.reduce((sum, entry) => sum + (entry.cost || 0), 0);
    }

    /**
     * Get costs summarized by model
     */
    getCostsByModel(): Record<string, { cost: number; calls: number }> {
        const models: Record<string, { cost: number; calls: number }> = {};

        // Initialize the summary object
        for (const entry of this.entries) {
            // Track by model
            if (!models[entry.model]) {
                models[entry.model] = {
                    cost: 0,
                    calls: 0,
                };
            }

            models[entry.model].cost += entry.cost || 0;
            models[entry.model].calls += 1;
        }

        return models;
    }

    /**
     * Print a summary of all costs to the console
     */
    printSummary(): void {
        if (!this.entries.length) {
            return;
        }

        const totalCost = this.getTotalCost();
        const costsByModel = this.getCostsByModel();
        const runtime = Math.round(
            (new Date().getTime() - this.started.getTime()) / 1000
        );

        console.log('\n\nCOST SUMMARY');
        console.log(`Runtime: ${runtime} seconds`);
        console.log(`Total API Cost: $${totalCost.toFixed(6)}`);

        console.log('\nModels:');
        // For each model within the provider
        for (const [model, modelData] of Object.entries(costsByModel)) {
            console.log(
                `\t${model}:\t$${modelData.cost.toFixed(6)} (${modelData.calls} calls)`
            );
        }

        // Print quota information
        console.log('\nQuota Summary:');
        const quotaSummary = quotaManager.getSummary();

        // Google/Gemini
        if (quotaSummary.google) {
            console.log('\tGoogle/Gemini:');
            console.log(
                `\t  • Daily Usage: ${quotaSummary.google.dailyUsed} / ${quotaSummary.google.dailyLimit} (${((quotaSummary.google.dailyUsed / quotaSummary.google.dailyLimit) * 100).toFixed(1)}%)`
            );
            console.log(
                `\t  • Last Reset: ${quotaSummary.google.lastReset?.toISOString().split('T')[0] || 'N/A'}`
            );
        }

        // OpenAI
        if (quotaSummary.openai) {
            console.log('\tOpenAI:');
            if (quotaSummary.openai.creditBalance !== undefined) {
                console.log(
                    `\t  • Credit Balance: $${quotaSummary.openai.creditBalance.toFixed(2)} / $${quotaSummary.openai.creditLimit.toFixed(2)}`
                );
            }

            // Free tier details
            if (quotaSummary.openai.freeTier) {
                console.log(
                    `\t  • Free Tier GPT-4/4o Family: ${quotaSummary.openai.freeTier.gpt4Family.used.toLocaleString()} / ${quotaSummary.openai.freeTier.gpt4Family.limit.toLocaleString()} tokens (${quotaSummary.openai.freeTier.gpt4Family.percent.toFixed(1)}%)`
                );
                console.log(
                    `\t  • Free Tier Mini Family: ${quotaSummary.openai.freeTier.gptMiniFamily.used.toLocaleString()} / ${quotaSummary.openai.freeTier.gptMiniFamily.limit.toLocaleString()} tokens (${quotaSummary.openai.freeTier.gptMiniFamily.percent.toFixed(1)}%)`
                );
            }
        }

        // X.AI/Grok
        if (quotaSummary.xai && quotaSummary.xai.creditBalance !== undefined) {
            console.log('\tX.AI/Grok:');
            console.log(
                `\t  • Credit Balance: $${quotaSummary.xai.creditBalance.toFixed(2)} / $${quotaSummary.xai.creditLimit.toFixed(2)}`
            );
        }

        this.reset();
    }

    /**
     * Reset the cost tracker (mainly for testing)
     */
    reset(): void {
        this.entries = [];
        this.started = new Date();
    }
}

// Export a singleton instance
export const costTracker = new CostTracker();
