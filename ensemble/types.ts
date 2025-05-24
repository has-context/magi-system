export * from '../common/shared-types.js';
import type {
    ToolFunction,
    ModelSettings,
    ModelClassID,
    StreamingEvent,
} from '../common/shared-types.js';

export interface EnsembleAgent {
    agent_id: string;
    getTools(): Promise<ToolFunction[]>;
    modelSettings?: ModelSettings;
    modelClass?: ModelClassID;
}

export interface RequestParams {
    agentId?: string;
    tools?: ToolFunction[];
    modelSettings?: ModelSettings;
    modelClass?: ModelClassID;
    onEvent?: (event: StreamingEvent) => void;
}
