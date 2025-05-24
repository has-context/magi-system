export interface UsageEntry {
    model: string;
    input_tokens?: number;
    output_tokens?: number;
    image_count?: number;
    timestamp?: Date;
}

class CostTracker {
    addUsage(_usage: UsageEntry): void {
        // In a standalone package we simply ignore cost tracking
    }
}

export const costTracker = new CostTracker();
