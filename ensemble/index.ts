import { getModelProvider } from './model_provider.js';
import type { ResponseInput, StreamingEvent } from './types.js';
import type { Agent } from '../utils/agent.js';

export interface RequestParams {
    agent?: Agent;
    onEvent?: (event: StreamingEvent) => void;
}

export async function* request(
    model: string,
    messages: ResponseInput,
    params: RequestParams = {}
): AsyncGenerator<StreamingEvent> {
    const provider = getModelProvider(model);
    for await (const event of provider.createResponseStream(
        model,
        messages,
        params.agent
    )) {
        if (params.onEvent) params.onEvent(event);
        yield event;
    }
}
