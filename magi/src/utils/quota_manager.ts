/**
 * Quota management for model providers
 *
 * This module tracks quota usage across different model providers and their free/paid tiers
 */

import { ModelProviderID } from '../../../ensemble/model_providers/model_data.js';
import { QuotaUpdateEvent } from '../types/shared-types.js';
import { sendStreamEvent } from './communication.js';

// Interface for tracking model-specific quota information
export interface ModelSpecificQuota {
    // Model identifier
    model: string;
    // Daily limits in tokens
    dailyTokenLimit: number;
    dailyTokensUsed: number;
    // Daily limits in requests
    dailyRequestLimit: number;
    dailyRequestsUsed: number;
    // Rate limits
    rateLimit?: {
        requestsPerMinute: number;
        tokensPerMinute: number;
    };
    // Reset dates/tracking
    lastResetDate?: Date;
}

// Main interface for tracking provider-level quota information
export interface ProviderQuota {
    provider: ModelProviderID;
    // Provider-level limits and credits
    creditBalance?: number;
    creditLimit?: number;
    // Provider-specific information (like OpenAI free tier quotas)
    info?: Record<string, any>;
    // Model-specific quotas
    models: Record<string, ModelSpecificQuota>;
    // Last reset date for the provider (used to trigger daily reset check)
    lastResetDate?: Date;
}

/**
 * Helper for tracking OpenAI free daily usage quotas.
 *
 * - Up to 1 million tokens per day across: gpt-4.5-preview, gpt-4.1, gpt-4o, o1, o3
 * - Up to 10 million tokens per day across: gpt-4.1-mini, gpt-4.1-nano, gpt-4o-mini, o1-mini, o3-mini, o4-mini
 */
interface OpenAIFreeQuota {
    // 1M tokens/day for main models
    gpt4Family: {
        limit: number;
        used: number;
    };
    // 10M tokens/day for mini/nano models
    gptMiniFamily: {
        limit: number;
        used: number;
    };
    // Models that count against the 1M token quota
    gpt4Models: string[];
    // Models that count against the 10M token quota
    gptMiniModels: string[];
}

/**
 * QuotaManager class to track and manage API quotas across providers and models
 */
export class QuotaManager {
    // Main storage structure: provider -> model -> quota
    private quotas: Record<string, ProviderQuota> = {};

    // Provider-specific tracking
    private openAIFreeQuota: OpenAIFreeQuota = {
        gpt4Family: {
            limit: 1000000, // 1M tokens
            used: 0,
        },
        gptMiniFamily: {
            limit: 10000000, // 10M tokens
            used: 0,
        },
        // Models counting against the 1M token limit
        gpt4Models: ['gpt-4.5-preview', 'gpt-4.1', 'gpt-4o', 'o1', 'o3'],
        // Models counting against the 10M token limit
        gptMiniModels: [
            'gpt-4.1-mini',
            'gpt-4.1-nano',
            'gpt-4o-mini',
            'o1-mini',
            'o3-mini',
            'o4-mini',
        ],
    };

    constructor() {
        this.initializeProviderQuotas();
    }

    /**
     * Initialize the quota information for all supported providers and their models
     */
    private initializeProviderQuotas() {
        // Google/Gemini with per-model quotas
        this.quotas['google'] = {
            provider: 'google',
            creditBalance: 0,
            creditLimit: 0,
            lastResetDate: new Date(), // Initialize provider reset date
            models: {
                // Gemini 2.5 Pro Experimental 03-25
                'gemini-2.5-pro-exp-03-25': {
                    model: 'gemini-2.5-pro-exp-03-25',
                    dailyTokenLimit: 1000000, // 1M tokens per day
                    dailyTokensUsed: 0,
                    dailyRequestLimit: 25, // 25 requests per day
                    dailyRequestsUsed: 0,
                    rateLimit: {
                        requestsPerMinute: 5,
                        tokensPerMinute: 250000, // 250K tokens per minute
                    },
                    lastResetDate: new Date(),
                },
                // Gemini 2.5 Flash Preview 04-17
                'gemini-2.5-flash-preview-04-17': {
                    model: 'gemini-2.5-flash-preview-04-17',
                    dailyTokenLimit: 0, // No explicit TPD limit, relying on RPD
                    dailyTokensUsed: 0,
                    dailyRequestLimit: 500, // 500 requests per day
                    dailyRequestsUsed: 0,
                    rateLimit: {
                        requestsPerMinute: 10,
                        tokensPerMinute: 250000,
                    },
                    lastResetDate: new Date(),
                },
                // Gemini 2.0 Flash
                'gemini-2.0-flash': {
                    model: 'gemini-2.0-flash',
                    dailyTokenLimit: 0, // No explicit TPD limit, relying on RPD
                    dailyTokensUsed: 0,
                    dailyRequestLimit: 1500, // 1,500 requests per day
                    dailyRequestsUsed: 0,
                    rateLimit: {
                        requestsPerMinute: 15,
                        tokensPerMinute: 1000000,
                    },
                    lastResetDate: new Date(),
                },
                // Gemini 2.0 Flash
                'gemini-2.0-flash-lite': {
                    model: 'gemini-2.0-flash-lite',
                    dailyTokenLimit: 0, // No explicit TPD limit, relying on RPD
                    dailyTokensUsed: 0,
                    dailyRequestLimit: 1500, // 1,500 requests per day
                    dailyRequestsUsed: 0,
                    rateLimit: {
                        requestsPerMinute: 30,
                        tokensPerMinute: 1000000,
                    },
                    lastResetDate: new Date(),
                },
            },
        };

        // OpenAI - Uses free tier family quotas
        this.quotas['openai'] = {
            provider: 'openai',
            creditBalance: 0,
            creditLimit: 0,
            lastResetDate: new Date(), // Initialize provider reset date
            info: {
                freeQuota: this.openAIFreeQuota,
            },
            models: {
                // Note: No default quota needed for OpenAI as family quotas are used.
            },
        };

        // X.AI/Grok
        this.quotas['xai'] = {
            provider: 'xai',
            creditBalance: 150, // $150 credit per month
            creditLimit: 150,
            lastResetDate: new Date(), // Initialize provider reset date
            models: {
                // Note: No default quota. Only explicitly listed models (if any) would be tracked.
            },
        };
    }

    /**
     * Get provider quota information
     */
    getProviderQuota(provider: ModelProviderID): ProviderQuota {
        return (
            this.quotas[provider] || {
                provider,
                models: {},
            }
        );
    }

    /**
     * Get model-specific quota information
     * If model doesn't exist, returns null
     */
    getModelQuota(
        provider: ModelProviderID,
        model: string
    ): ModelSpecificQuota | null {
        const providerQuota = this.getProviderQuota(provider);

        // Return the specific model quota if it exists
        if (providerQuota.models[model]) {
            return providerQuota.models[model];
        }

        // Otherwise, return null as no specific quota exists
        return null;
    }

    /**
     * Track usage for a specific provider and model
     * Returns true if the quota is still available, false if exceeded
     */
    trackUsage(
        provider: ModelProviderID,
        model: string,
        inputTokens: number,
        outputTokens: number
    ): boolean {
        // Check if we have quota information for this provider
        if (!this.quotas[provider]) {
            return true; // Assume quota is available if we don't track it
        }

        // Get provider quota
        const providerQuota = this.quotas[provider];
        let significantChange = false;
        const totalTokens = inputTokens + outputTokens;

        // Check if daily reset is needed based on provider-level last reset date
        const today = new Date();
        if (
            providerQuota.lastResetDate &&
            (today.getUTCDate() !== providerQuota.lastResetDate.getUTCDate() ||
                today.getUTCMonth() !==
                    providerQuota.lastResetDate.getUTCMonth() ||
                today.getUTCFullYear() !==
                    providerQuota.lastResetDate.getUTCFullYear())
        ) {
            // Reset all model-specific quotas for this provider
            for (const modelKey in providerQuota.models) {
                const modelQuota = providerQuota.models[modelKey];
                modelQuota.dailyTokensUsed = 0;
                modelQuota.dailyRequestsUsed = 0;
                modelQuota.lastResetDate = today; // Update model's reset date
            }

            // Reset OpenAI free tier family quotas specifically
            if (provider === 'openai' && providerQuota.info?.freeQuota) {
                const freeQuota = providerQuota.info
                    .freeQuota as OpenAIFreeQuota;
                freeQuota.gpt4Family.used = 0;
                freeQuota.gptMiniFamily.used = 0;
            }

            // Update the provider-level last reset date
            providerQuota.lastResetDate = today;
            significantChange = true; // Daily reset is significant
        }

        // Track OpenAI free tier usage separately as it's family-based
        if (provider === 'openai' && providerQuota.info?.freeQuota) {
            const freeQuota = providerQuota.info.freeQuota as OpenAIFreeQuota;

            // Track GPT-4 family usage
            if (freeQuota.gpt4Models.includes(model)) {
                const prevUsed = freeQuota.gpt4Family.used;
                freeQuota.gpt4Family.used += totalTokens;
                console.log(
                    `[QuotaManager] OpenAI GPT-4 family usage: ${freeQuota.gpt4Family.used}/${freeQuota.gpt4Family.limit}`
                );

                // Check for significant changes in GPT-4 family usage
                const prevPercent = Math.floor(
                    (prevUsed / freeQuota.gpt4Family.limit) * 10
                );
                const currPercent = Math.floor(
                    (freeQuota.gpt4Family.used / freeQuota.gpt4Family.limit) *
                        10
                );
                if (prevPercent !== currPercent) {
                    significantChange = true;
                }

                // Check if exceeded limit
                if (freeQuota.gpt4Family.used >= freeQuota.gpt4Family.limit) {
                    console.log(
                        `[QuotaManager] OpenAI GPT-4 family daily limit reached: ${freeQuota.gpt4Family.used} > ${freeQuota.gpt4Family.limit}`
                    );
                    significantChange = true; // Exceeding quota is significant
                    this.sendQuotaUpdate(); // Update immediately when quota is exceeded
                    return false; // Exceeded quota
                }
            }

            // Track GPT-Mini family usage
            if (freeQuota.gptMiniModels.includes(model)) {
                const prevUsed = freeQuota.gptMiniFamily.used;
                freeQuota.gptMiniFamily.used += totalTokens;
                console.log(
                    `[QuotaManager] OpenAI GPT-Mini family usage: ${freeQuota.gptMiniFamily.used}/${freeQuota.gptMiniFamily.limit}`
                );

                // Check for significant changes in Mini family usage
                const prevPercent = Math.floor(
                    (prevUsed / freeQuota.gptMiniFamily.limit) * 10
                );
                const currPercent = Math.floor(
                    (freeQuota.gptMiniFamily.used /
                        freeQuota.gptMiniFamily.limit) *
                        10
                );
                if (prevPercent !== currPercent) {
                    significantChange = true;
                }

                // Check if exceeded limit
                if (
                    freeQuota.gptMiniFamily.used >=
                    freeQuota.gptMiniFamily.limit
                ) {
                    console.log(
                        `[QuotaManager] OpenAI GPT-Mini family daily limit reached: ${freeQuota.gptMiniFamily.used} > ${freeQuota.gptMiniFamily.limit}`
                    );
                    significantChange = true; // Exceeding quota is significant
                    this.sendQuotaUpdate(); // Update immediately when quota is exceeded
                    return false; // Exceeded quota
                }
            }
        }

        // Get model-specific quota
        const modelQuota = this.getModelQuota(provider, model);

        // If no specific quota exists for this model (and it's not OpenAI), assume available
        if (!modelQuota && provider !== 'openai') {
            return true;
        }

        // Track usage only if a specific model quota exists (for non-OpenAI providers)
        if (modelQuota) {
            // Track general token usage
            const previousDailyTokensUsed = modelQuota.dailyTokensUsed;
            modelQuota.dailyTokensUsed += totalTokens;

            // Track request usage - increment by 1 for each call
            const previousDailyRequestsUsed = modelQuota.dailyRequestsUsed;
            modelQuota.dailyRequestsUsed += 1;

            // Check if this usage significantly changes our daily token usage percentage
            if (modelQuota.dailyTokenLimit > 0) {
                const previousPercent = Math.floor(
                    (previousDailyTokensUsed / modelQuota.dailyTokenLimit) * 10
                ); // Percentage in tenths
                const currentPercent = Math.floor(
                    (modelQuota.dailyTokensUsed / modelQuota.dailyTokenLimit) *
                        10
                );

                if (previousPercent !== currentPercent) {
                    significantChange = true; // 10% increment in token usage
                }
            }

            // Check if this usage significantly changes our daily request usage percentage
            if (modelQuota.dailyRequestLimit > 0) {
                const previousPercent = Math.floor(
                    (previousDailyRequestsUsed / modelQuota.dailyRequestLimit) *
                        10
                ); // Percentage in tenths
                const currentPercent = Math.floor(
                    (modelQuota.dailyRequestsUsed /
                        modelQuota.dailyRequestLimit) *
                        10
                );

                if (previousPercent !== currentPercent) {
                    significantChange = true; // 10% increment in request usage
                }
            }

            // Check if we've exceeded daily token limit
            if (
                modelQuota.dailyTokenLimit > 0 &&
                modelQuota.dailyTokensUsed >= modelQuota.dailyTokenLimit
            ) {
                console.log(
                    `[QuotaManager] ${provider} model ${model} daily token limit reached: ${modelQuota.dailyTokensUsed} > ${modelQuota.dailyTokenLimit}`
                );
                significantChange = true; // Exceeding quota is significant
                this.sendQuotaUpdate(); // Update immediately when quota is exceeded
                return false; // Exceeded quota
            }

            // Check if we've exceeded daily request limit
            if (
                modelQuota.dailyRequestLimit > 0 &&
                modelQuota.dailyRequestsUsed >= modelQuota.dailyRequestLimit
            ) {
                console.log(
                    `[QuotaManager] ${provider} model ${model} daily request limit reached: ${modelQuota.dailyRequestsUsed} > ${modelQuota.dailyRequestLimit}`
                );
                significantChange = true; // Exceeding quota is significant
                this.sendQuotaUpdate(); // Update immediately when quota is exceeded
                return false; // Exceeded quota
            }
        }

        // If there was a significant change in quotas, send an update
        if (significantChange) {
            this.sendQuotaUpdate();
        }

        return true; // Quota available
    }

    /**
     * Check if there's remaining quota for a provider/model
     * Returns true if quota is available
     */
    hasQuota(provider: ModelProviderID, model: string): boolean {
        // First check OpenAI family quotas if applicable
        if (provider === 'openai') {
            return this.hasOpenAIFreeQuota(model);
        }

        // For Google and other providers with model-specific quotas
        const modelQuota = this.getModelQuota(provider, model);
        if (modelQuota) {
            // Check both token and request limits if they exist
            return (
                (modelQuota.dailyTokenLimit === 0 ||
                    modelQuota.dailyTokensUsed < modelQuota.dailyTokenLimit) &&
                (modelQuota.dailyRequestLimit === 0 ||
                    modelQuota.dailyRequestsUsed < modelQuota.dailyRequestLimit)
            );
        }

        // Default to true for cases we don't track (i.e., model not explicitly defined)
        return true;
    }

    /**
     * Check if there's remaining free tier quota for specific OpenAI model families
     */
    hasOpenAIFreeQuota(model: string): boolean {
        const providerQuota = this.getProviderQuota('openai'); // Use getter
        if (!providerQuota || !providerQuota.info?.freeQuota) return true;

        const freeQuota = providerQuota.info.freeQuota as OpenAIFreeQuota;

        // Check GPT-4o/4.5 family
        if (freeQuota.gpt4Models.includes(model)) {
            return freeQuota.gpt4Family.used < freeQuota.gpt4Family.limit;
        }

        // Check GPT-4o-mini family
        if (freeQuota.gptMiniModels.includes(model)) {
            return freeQuota.gptMiniFamily.used < freeQuota.gptMiniFamily.limit;
        }

        return true;
    }

    /**
     * Track credit usage for a provider
     */
    trackCreditUsage(provider: ModelProviderID, creditAmount: number): void {
        const providerQuota = this.getProviderQuota(provider); // Use getter
        if (!providerQuota || providerQuota.creditBalance === undefined) {
            return;
        }

        if (providerQuota.creditBalance !== undefined) {
            providerQuota.creditBalance = Math.max(
                0,
                providerQuota.creditBalance - creditAmount
            );
        }
    }

    /**
     * Get the remaining credit balance for a provider
     */
    getCreditBalance(provider: ModelProviderID): number {
        return this.getProviderQuota(provider)?.creditBalance || 0; // Use getter
    }

    /**
     * Get a summary of all quota usage across providers and models
     */
    getSummary(): Record<string, any> {
        const summary: Record<string, any> = {};

        for (const [provider, providerQuota] of Object.entries(this.quotas)) {
            // Start with provider-level information
            summary[provider] = {
                creditBalance: providerQuota.creditBalance,
                creditLimit: providerQuota.creditLimit,
                models: {},
            };

            // Add model-specific quotas
            for (const [modelName, modelQuota] of Object.entries(
                providerQuota.models
            )) {
                // No need to skip _default as it's removed
                summary[provider].models[modelName] = {
                    tokens: {
                        used: modelQuota.dailyTokensUsed,
                        limit: modelQuota.dailyTokenLimit,
                        percent:
                            modelQuota.dailyTokenLimit > 0
                                ? (modelQuota.dailyTokensUsed /
                                      modelQuota.dailyTokenLimit) *
                                  100
                                : 0,
                    },
                    requests: {
                        used: modelQuota.dailyRequestsUsed,
                        limit: modelQuota.dailyRequestLimit,
                        percent:
                            modelQuota.dailyRequestLimit > 0
                                ? (modelQuota.dailyRequestsUsed /
                                      modelQuota.dailyRequestLimit) *
                                  100
                                : 0,
                    },
                    lastReset: modelQuota.lastResetDate,
                };
            }

            // Add OpenAI free tier details if available
            if (provider === 'openai' && providerQuota.info?.freeQuota) {
                const freeQuota = providerQuota.info
                    .freeQuota as OpenAIFreeQuota;
                summary[provider].freeTier = {
                    gpt4Family: {
                        used: freeQuota.gpt4Family.used,
                        limit: freeQuota.gpt4Family.limit,
                        percent:
                            (freeQuota.gpt4Family.used /
                                freeQuota.gpt4Family.limit) *
                            100,
                    },
                    gptMiniFamily: {
                        used: freeQuota.gptMiniFamily.used,
                        limit: freeQuota.gptMiniFamily.limit,
                        percent:
                            (freeQuota.gptMiniFamily.used /
                                freeQuota.gptMiniFamily.limit) *
                            100,
                    },
                };
            }
        }

        return summary;
    }

    /**
     * Send the current quota information to the UI
     */
    sendQuotaUpdate(): void {
        try {
            const quotas = this.getSummary();
            const quotaEvent: QuotaUpdateEvent = {
                type: 'quota_update',
                quotas,
            };
            sendStreamEvent(quotaEvent);
        } catch (error) {
            console.error('Error sending quota update:', error);
        }
    }
}

// Export a singleton instance
export const quotaManager = new QuotaManager();
