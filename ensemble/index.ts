import {
    ModelSettings,
    ToolFunction,
    ResponseInput,
    StreamingEvent,
    ModelClassID,
    EnsembleAgent,
    RequestParams,
} from './types.js';
import {
    getModelProvider,
} from './model_providers/model_provider.js';

class RequestAgent implements EnsembleAgent {
    agent_id: string;
    modelSettings?: ModelSettings;
    modelClass?: ModelClassID;
    private tools: ToolFunction[];
    constructor(params: RequestParams) {
        this.agent_id = params.agentId || 'ensemble';
        this.modelSettings = params.modelSettings;
        this.modelClass = params.modelClass;
        this.tools = params.tools || [];
    }
    async getTools(): Promise<ToolFunction[]> {
        return this.tools;
    }
}

export async function* request(
    model: string,
    messages: ResponseInput,
    params: RequestParams = {}
): AsyncGenerator<StreamingEvent> {
    const provider = getModelProvider(model);
    const agent = new RequestAgent(params);
    const stream = provider.createResponseStream(model, messages, agent as any);
    for await (const event of stream) {
        if (params.onEvent) params.onEvent(event);
        yield event;
    }
}
