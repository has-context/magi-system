/**
 * Common type definitions for the MAGI system.
 *
 * THIS FILE IS LOCATED AT common/shared-types.ts
 * DO NOT COPY INTO ANOTHER LOCATION DURING DEVELOPMENT
 */
declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace NodeJS {
        interface ProcessEnv {
            NODE_ENV: 'development' | 'production';
            PROCESS_ID: string;
            CONTROLLER_PORT: string;
            HOST_HOSTNAME: string;
            OPENROUTER_API_KEY?: string;
            OPENAI_API_KEY?: string;
            ANTHROPIC_API_KEY?: string;
            GOOGLE_API_KEY?: string;
            XAI_API_KEY?: string;
            DEEPSEEK_API_KEY?: string;
            BRAVE_API_KEY?: string;
            PROJECT_REPOSITORIES?: string;
            PROJECT_PARENT_PATH?: string;
            PROCESS_PROJECTS?: string;
            PROJECT_PORTS?: string;
        }
    }
}

// Define the Agent interface to avoid circular dependency
export interface AgentInterface {
    agent_id: string;
    name: string;
    description: string;
    instructions: string;
    parent_id?: string;
    workers?: AgentInterface[];
    tools?: ToolFunction[];
    model?: string;
    modelClass?: string;
    modelSettings?: ModelSettings;
    maxToolCalls?: number;
    verifier?: AgentInterface; // Optional verifier agent
    onToolCall?: (toolCall: ToolCall) => void;
    onToolResult?: (toolCall: ToolCall, result: string) => void;
    tryDirectExecution?: (
        messages: ResponseInput
    ) => Promise<ResponseInput | null>; // Added from AgentDefinition
    export(): AgentExportDefinition;
    asTool(): ToolFunction;
}

export interface AgentProcess {
    processId: string;
    started: Date;
    status:
        | 'started'
        | 'running'
        | 'waiting'
        | 'completed'
        | 'failed'
        | 'terminated';
    tool: ProcessToolType;
    command: string;
    name: string;
    output?: string;
    error?: string;
    history?: ResponseInput;
    projectIds?: string[]; // List of git repositories to mount
}

export type ToolParameterType =
    | 'string'
    | 'number'
    | 'boolean'
    | 'object'
    | 'array'
    | 'null';
export const validToolParameterTypes: ToolParameterType[] = [
    'string',
    'number',
    'boolean',
    'object',
    'array',
    'null',
];

/**
 * Tool parameter type definitions using strict schema format for OpenAI function calling
 */
export interface ToolParameter {
    type?: ToolParameterType;
    description?: string | (() => string);
    enum?: string[] | (() => Promise<string[]>);
    items?:
        | ToolParameter
        | {
              type: ToolParameterType;
              enum?: string[] | (() => Promise<string[]>);
          };
    properties?: Record<string, ToolParameter>;
    required?: string[];
    optional?: boolean;
    minItems?: number;

    [key: string]: any;
}

export type ExecutableFunction = (...args: any[]) => Promise<string> | string;
export type WorkerFunction = (...args: any[]) => AgentInterface;

/**
 * Definition for a tool that can be used by an agent
 */
export interface ToolFunction {
    function: ExecutableFunction;
    definition: ToolDefinition;
    injectAgentId?: boolean;
    injectAbortSignal?: boolean;
}

/**
 * Definition for a tool that can be used by an agent
 */
export interface ToolDefinition {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: {
            type: 'object';
            properties: Record<string, ToolParameter>;
            required: string[];
        };
    };
}

/**
 * Type definition for tool implementation functions
 */
export type ToolImplementationFn = (...args: any[]) => any | Promise<any>;

export type ToolParameterMap = {
    [key: string]: string | ToolParameter;
};

export interface VerifierResult {
    status: 'pass' | 'fail';
    reason?: string;
}

/**
 * Definition of an agent with model and tool settings
 */
export interface AgentDefinition {
    agent_id?: string;
    name: string;
    description: string;
    instructions: string;
    workers?: WorkerFunction[];
    tools?: ToolFunction[];
    model?: string;
    modelClass?: ModelClassID;
    modelSettings?: ModelSettings;
    maxToolCalls?: number;
    maxToolCallRoundsPerTurn?: number; // Maximum number of tool call rounds per turn
    verifier?: AgentDefinition;
    maxVerificationAttempts?: number;
    jsonSchema?: ResponseJSONSchema; // JSON schema definition for structured output
    historyThread?: ResponseInput | undefined;
    cwd?: string; // Working directory for model providers that need a real shell context

    onToolCall?: (toolCall: ToolCall) => Promise<void>;
    onToolResult?: (toolCall: ToolCall, result: string) => Promise<void>;
    onRequest?: (
        agent: AgentInterface, // Reverted back to AgentInterface
        messages: ResponseInput
    ) => Promise<[any, ResponseInput]>; // Reverted back to AgentInterface
    onResponse?: (message: ResponseOutputMessage) => Promise<void>;
    onThinking?: (message: ResponseThinkingMessage) => Promise<void>;
    tryDirectExecution?: (
        messages: ResponseInput
    ) => Promise<ResponseInput | null>; // Add this line

    params?: ToolParameterMap; // Map of parameter names to their definitions
    processParams?: (
        agent: AgentInterface,
        params: Record<string, any>
    ) => Promise<{
        prompt: string;
        intelligence?: 'low' | 'standard' | 'high';
    }>;
}

/**
 * Definition-exportable version of the agent
 */
export interface AgentExportDefinition {
    agent_id: string;
    name: string;
    parent_id?: string;
    model?: string;
    modelClass?: string;
    cwd?: string; // Working directory for model providers that need a real shell context
}

export interface ResponseJSONSchema {
    /**
     * The name of the response format. Must be a-z, A-Z, 0-9, or contain underscores
     * and dashes, with a maximum length of 64.
     */
    name: string;

    /**
     * The schema for the response format, described as a JSON Schema object. Learn how
     * to build JSON schemas [here](https://json-schema.org/).
     */
    schema: Record<string, unknown>;

    /**
     * The type of response format being defined. Always `json_schema`.
     */
    type: 'json_schema';

    /**
     * A description of what the response format is for, used by the model to determine
     * how to respond in the format.
     */
    description?: string;

    /**
     * Whether to enable strict schema adherence when generating the output. If set to
     * true, the model will always follow the exact schema defined in the `schema`
     * field. Only a subset of JSON Schema is supported when `strict` is `true`. To
     * learn more, read the
     * [Structured Outputs guide](https://platform.openai.com/docs/guides/structured-outputs).
     */
    strict?: boolean | null;
}

/**
 * Model settings for the OpenAI API
 */
export interface ModelSettings {
    temperature?: number;
    top_p?: number;
    top_k?: number;
    max_tokens?: number;
    stop_sequence?: string;
    seed?: number;
    text?: { format: string };
    tool_choice?:
        | 'auto'
        | 'none'
        | 'required'
        | { type: string; function: { name: string } };
    sequential_tools?: boolean; // Run tools sequentially instead of in parallel
    json_schema?: ResponseJSONSchema; // JSON schema for structured output
    force_json?: boolean; // Force JSON output even if model doesn't natively support it
}

/**
 * Tool call data structure
 */
export interface ToolCall {
    id: string;
    type: 'function';
    call_id?: string;
    function: {
        name: string;
        arguments: string;
    };
}

export interface ToolCallHandler {
    onToolCall?: (toolCall: ToolCall) => void;
    onToolResult?: (toolCall: ToolCall, result: string) => void;
    onEvent?: (event: StreamingEvent) => void;
}

export interface ResponseContentText {
    type: 'input_text';
    text: string;
}

export interface ResponseContentImage {
    type: 'input_image';
    detail: 'high' | 'low' | 'auto';
    file_id?: string;
    image_url?: string;
}

export interface ResponseContentFileInput {
    type: 'input_file';
    file_data?: string;
    file_id?: string;
    filename?: string;
}

/**
 * ResponseContent
 */
export type ResponseContent =
    | string
    | Array<
          ResponseContentText | ResponseContentImage | ResponseContentFileInput
      >;

/**
 * ResponseInput
 */
export type ResponseInput = Array<ResponseInputItem>;
export type ResponseInputItem =
    | ResponseInputMessage
    | ResponseThinkingMessage
    | ResponseOutputMessage
    | ResponseInputFunctionCall
    | ResponseInputFunctionCallOutput;

export interface ResponseBaseMessage {
    type: string;
    model?: string;
    timestamp?: number; // Timestamp for the event, shared by all event types
}

/**
 * ResponseInputMessage
 */
export interface ResponseInputMessage extends ResponseBaseMessage {
    type: 'message';
    name?: string; // deprecated
    content: ResponseContent;
    role: 'user' | 'system' | 'developer';
    status?: 'in_progress' | 'completed' | 'incomplete';
}

/**
 * ResponseThinkingMessage
 */
export interface ResponseThinkingMessage extends ResponseBaseMessage {
    type: 'thinking';
    content: ResponseContent;
    signature?: ResponseContent;
    thinking_id?: string;
    role: 'assistant';
    status?: 'in_progress' | 'completed' | 'incomplete';
}

export interface ResponseReasoningItem extends ResponseBaseMessage {
    type: 'reasoning';
    id: string;
    summary: Array<{
        text: string;
        type: 'summary_text';
    }>;
    status?: 'in_progress' | 'completed' | 'incomplete';
}

/**
 * ResponseOutputMessage
 */
export interface ResponseOutputMessage extends ResponseBaseMessage {
    id?: string;
    type: 'message';
    content: ResponseContent;
    role: 'assistant';
    status: 'in_progress' | 'completed' | 'incomplete';
}

/**
 * Tool call data structure
 */
export interface ResponseInputFunctionCall extends ResponseBaseMessage {
    type: 'function_call';
    call_id: string;
    name: string;
    arguments: string;
    id?: string;
    status?: 'in_progress' | 'completed' | 'incomplete';
}

/**
 * Tool call data structure
 */
export interface ResponseInputFunctionCallOutput extends ResponseBaseMessage {
    type: 'function_call_output';
    call_id: string;
    name?: string;
    output: string;
    id?: string;
    status?: 'in_progress' | 'completed' | 'incomplete';
}

/**
 * Response data from the LLM
 */
export interface LLMMessage {
    name?: string | undefined;
    role: string;
    content: string | null;
    tool_calls?: ToolCall[];
    call_id?: string; // For tool response messages
}

/**
 * Response data from the LLM
 */
export interface LLMResponse extends LLMMessage {
    role: 'assistant';
    tool_calls?: ToolCall[];
}

/**
 * Streaming event types
 */
export type StreamEventType =
    | 'connected'
    | 'command_start'
    | 'command_done'
    | 'project_create'
    | 'project_update'
    | 'process_start'
    | 'process_running'
    | 'process_updated'
    | 'process_done'
    | 'process_failed'
    | 'process_waiting'
    | 'process_terminated'
    | 'agent_start'
    | 'agent_updated'
    | 'agent_done'
    | 'agent_status'
    | 'message_start'
    | 'message_delta'
    | 'message_complete'
    | 'talk_start'
    | 'talk_delta'
    | 'talk_complete'
    | 'audio_stream'
    | 'tool_start'
    | 'tool_delta'
    | 'tool_done'
    | 'file_start'
    | 'file_delta'
    | 'file_complete'
    | 'cost_update'
    | 'system_status'
    | 'system_update'
    | 'quota_update'
    | 'screenshot'
    | 'design_grid'
    | 'console'
    | 'error'
    // New types for waiting on tools
    | 'tool_wait_start'
    | 'tool_waiting'
    | 'tool_wait_complete'
    // New types for waiting on tasks
    | 'task_wait_start'
    | 'task_waiting'
    | 'task_wait_complete'
    // Git-related events
    | 'git_pull_request';

/**
 * Base streaming event interface
 */
export interface StreamEvent {
    type: StreamEventType;
    agent?: AgentExportDefinition;
    timestamp?: string; // Timestamp for the event, shared by all event types
}

// --- Tool Wait Events ---

/**
 * Event indicating the start of waiting for a tool.
 */
export interface ToolWaitStartEvent extends StreamEvent {
    type: 'tool_wait_start';
    runningToolId: string;
    timestamp: string;
    overseer_notification?: boolean; // Flag to let the overseer know the agent is deliberately waiting
}

/**
 * Heartbeat event while waiting for a tool.
 */
export interface ToolWaitingEvent extends StreamEvent {
    type: 'tool_waiting';
    runningToolId: string;
    elapsedSeconds: number;
    timestamp: string;
}

/**
 * Event indicating the completion of waiting for a tool.
 */
export interface ToolWaitCompleteEvent extends StreamEvent {
    type: 'tool_wait_complete';
    runningToolId: string;
    result: string; // The final message returned by wait_for_running_tool
    finalStatus: string; // Status like 'completed', 'failed', 'terminated', 'timeout', 'unknown'
    timestamp: string;
}

// --- Task Wait Events ---

/**
 * Event indicating the start of waiting for a task.
 */
export interface TaskWaitStartEvent extends StreamEvent {
    type: 'task_wait_start';
    taskId: string;
    timestamp: string;
    overseer_notification?: boolean; // Flag to let the overseer know the agent is deliberately waiting
}

/**
 * Heartbeat event while waiting for a task.
 */
export interface TaskWaitingEvent extends StreamEvent {
    type: 'task_waiting';
    taskId: string;
    elapsedSeconds: number;
    timestamp: string;
}

/**
 * Event indicating the completion of waiting for a task.
 */
export interface TaskWaitCompleteEvent extends StreamEvent {
    type: 'task_wait_complete';
    taskId: string;
    result: string; // The final message returned by wait_for_running_task
    finalStatus: string; // Status like 'completed', 'failed', 'terminated', 'timeout', 'unknown'
    timestamp: string;
}

/**
 * Git pull request event for container to controller communication
 */
export interface GitPullRequestEvent extends StreamEvent {
    type: 'git_pull_request';
    processId: string;
    projectId: string;
    branch: string;
    message: string;
    timestamp: string;
}

/**
 * Agent updated streaming event
 */
export interface ConnectedEvent extends StreamEvent {
    type: 'connected';
    timestamp: string;
}

/**
 * Agent updated streaming event
 */
export interface CommandEvent extends StreamEvent {
    type: 'command_start' | 'command_done';
    targetProcessId: string;
    command: string;
    timestamp?: string; // Timestamp for the event
}

export type ProjectType =
    | 'web-static'
    | 'web-app'
    | 'game-2d'
    | 'game-3d'
    | 'mobile-app'
    | 'desktop-app'
    | 'plain';

export interface Project {
    project_id: string;
    project_type?: ProjectType;
    simple_description?: string;
    detailed_description?: string;
    repository_url?: string;
    is_generated?: boolean;
    is_ready?: boolean;
}

/**
 * Project updated streaming event
 */
export interface ProjectEvent extends StreamEvent {
    type: 'project_create' | 'project_update';
    project_id: string;
}

export type ProcessToolType =
    | 'research'
    | 'browse'
    | 'web_code'
    | 'code'
    | 'project_update'
    | 'other';

/**
 * Agent updated streaming event
 */
export interface ProcessEvent extends StreamEvent {
    type:
        | 'process_start'
        | 'process_running'
        | 'process_updated'
        | 'process_done'
        | 'process_failed'
        | 'process_waiting'
        | 'process_terminated';
    agentProcess?: AgentProcess;
    output?: string;
    error?: string;
    history?: ResponseInput;
}

/**
 * Agent updated streaming event
 */
export interface AgentEvent extends StreamEvent {
    type: 'agent_start' | 'agent_updated' | 'agent_done';
    agent: AgentExportDefinition;
    input?: string;
}

/**
 * Agent updated streaming event
 */
export interface AgentStatusEvent extends StreamEvent {
    type: 'agent_status';
    agent_id: string;
    status: string;
    meta_data?: Record<string, unknown>; // Replaced any with Record<string, unknown>
}

/**
 * Message streaming event
 */
export interface MessageEventBase extends StreamEvent {
    type: StreamEventType;
    content: string;
    message_id: string; // Added message_id for tracking deltas and completes
    order?: number; // Optional order property for message sorting
    thinking_content?: string;
    thinking_signature?: string;
}

/**
 * Message streaming event
 */
export interface MessageEvent extends MessageEventBase {
    type: 'message_start' | 'message_delta' | 'message_complete';
}

/**
 * Message streaming event
 */
export interface FileEvent extends StreamEvent {
    type: 'file_start' | 'file_delta' | 'file_complete';
    message_id: string; // Added message_id for tracking deltas and completes
    mime_type?: string;
    data_format: 'base64';
    data: string;
    order?: number; // Optional order property for message sorting
}

/**
 * Message streaming event
 */
export interface TalkEvent extends MessageEventBase {
    type: 'talk_start' | 'talk_delta' | 'talk_complete';
}

/**
 * Tool call streaming event
 */
export interface ToolEvent extends StreamEvent {
    type: 'tool_start' | 'tool_delta' | 'tool_done';
    tool_calls: ToolCall[];
    results?: any;
}

/**
 * Error streaming event
 */
export interface ErrorEvent extends StreamEvent {
    type: 'error';
    error: string;
}

/**
 * Audio streaming event
 */
export interface AudioEvent extends StreamEvent {
    type: 'audio_stream';
    timestamp: string;
    chunkIndex?: number;
    isFinalChunk?: boolean;
    data?: string;
    format?: string;
    pcmParameters?: {
        sampleRate?: number;
        channels?: number;
        bitDepth?: number;
    };
}

/**
 * Screenshot streaming event
 */
export interface ScreenshotEvent extends StreamEvent {
    type: 'screenshot';
    data: string; // Base64 encoded image data
    timestamp: string;
    url?: string; // Optional current URL
    viewport: {
        // Optional viewport rectangle for cropping/highlighting
        x: number;
        y: number;
        width: number;
        height: number;
    };
    cursor: {
        x: number;
        y: number;
        button?: 'none' | 'left' | 'middle' | 'right';
    };
}

export interface DesignGridEvent extends StreamEvent {
    type: 'design_grid';
    data: string;
    timestamp: string;
}

/**
 * Console output streaming event
 */
export interface ConsoleEvent extends StreamEvent {
    type: 'console';
    data: string; // Raw terminal output
    timestamp: string;
    message_id?: string; // Optional reference to the message that generated this console output
}

/**
 * Interface for model usage data
 */
export interface ModelUsage {
    model: string;
    cost?: number;
    input_tokens?: number; // Made optional to match model_data.ts
    output_tokens?: number; // Made optional to match model_data.ts
    cached_tokens?: number;
    image_count?: number; // Added to match model_data.ts
    metadata?: Record<string, any>;
    timestamp?: string | Date; // Support both string and Date types
    isFreeTierUsage?: boolean; // Added flag for free tier usage
}

// New interface for the core cost data structure
export interface CostUpdateData {
    time: {
        start: string;
        now: string;
    };
    cost: {
        total: number; // Total cost accumulated
        last_min: number; // Cost accumulated in the last minute
    };
    tokens: {
        input: number; // Total input tokens accumulated
        output: number; // Total output tokens accumulated
    };
    models: Record<string, { cost: number; calls: number }>; // Per-model cost and call count
}

/**
 * Cost update streaming event
 */
export interface CostUpdateEvent extends StreamEvent {
    type: 'cost_update';
    usage: ModelUsage;
    thought_delay?: number;
}

/**
 * Cost update streaming event
 */
export interface SystemStatusEvent extends StreamEvent {
    type: 'system_status';
    status: string;
}

/**
 * Cost update streaming event
 */
export interface SystemUpdateEvent extends MessageEventBase {
    type: 'system_update';
}

/**
 * Quota update streaming event
 */
export interface QuotaUpdateEvent extends StreamEvent {
    type: 'quota_update';
    quotas: Record<string, any>;
}

/**
 * Union type for all streaming events
 */
export type StreamingEvent =
    | ConnectedEvent
    | CommandEvent
    | ProjectEvent
    | ProcessEvent
    | AgentEvent
    | AgentStatusEvent
    | MessageEvent
    | FileEvent
    | TalkEvent
    | ToolEvent
    | ErrorEvent
    | CostUpdateEvent
    | SystemStatusEvent
    | SystemUpdateEvent
    | QuotaUpdateEvent
    | AudioEvent
    | ScreenshotEvent
    | DesignGridEvent
    | ConsoleEvent
    | GitPullRequestEvent
    // Add new wait events
    | ToolWaitStartEvent
    | ToolWaitingEvent
    | ToolWaitCompleteEvent
    | TaskWaitStartEvent
    | TaskWaitingEvent
    | TaskWaitCompleteEvent;

/**
 * Process status type (used by controller)
 */
export type ProcessStatus =
    | 'running'
    | 'completed'
    | 'failed'
    | 'terminated'
    | 'ending';

/**
 * MagiMessage format for communication between containers and controller
 */
export interface MagiMessage {
    processId: string;
    event: StreamingEvent;
}

/**
 * Global cost data structure for the controller
 */
export interface GlobalCostData {
    usage: CostUpdateData; // The accumulated global usage data
    costPerMinute: number; // Calculated cost per minute since system start
    numProcesses: number; // Current number of tracked processes
    systemStartTime: string; // ISO string timestamp of when tracking started
}

// Socket.io event interfaces

/**
 * Event sent when a new process is created
 */
export interface ProcessCreateEvent {
    id: string; // Process ID
    command: string; // Command that created the process
    name: string;
    status: ProcessStatus; // Initial status (usually 'running')
    colors: {
        rgb: string; // Primary color (rgb)
        bgColor: string; // Background color (rgba)
        textColor: string; // Text color (rgba)
    };
}

/**
 * Event sent when new logs are available for a process
 */
export interface ProcessLogsEvent {
    id: string; // Process ID
    logs: string; // Log content (may include markdown)
}

/**
 * Event sent when a structured message from a MAGI container is available
 */
export interface ProcessMessageEvent {
    id: string; // Process ID
    message: MagiMessage; // Structured message from the container
}

/**
 * Event sent when a process status changes
 */
export interface ProcessUpdateEvent {
    id: string; // Process ID
    status: ProcessStatus; // New status
}

/**
 * Event for sending a command to a specific process
 */
export interface ProcessCommandEvent {
    processId: string; // Target process ID
    command: string; // Command to send
    sourceProcessId?: string; // Optional source process ID for process-to-process communication
}

/**
 * Event for server information sent to clients
 */
export interface ServerInfoEvent {
    version: string; // Server version
}

/**
 * Position for absolute positioning of boxes
 */
export interface BoxPosition {
    x: number;
    y: number;
    width: number;
    height: number;
    scale: number;
}

/**
 * Client-side DOM element references for processes
 */
export interface ProcessElement {
    box: HTMLElement; // Container element
    logs: HTMLElement; // Log output container
    status: HTMLElement; // Status indicator
    input?: HTMLInputElement; // Optional process-specific input field
}

/**
 * App settings interface for persisting UI and feature settings
 */
export interface AppSettings {
    uiMode: 'canvas' | 'column';
    isAudioEnabled: boolean;
    isTelegramEnabled: boolean;
}

/**
 * Status of a sequential agent run
 */
export enum RunStatus {
    SUCCESS = 'success',
    FAILURE = 'failure',
    NEEDS_RETRY = 'needs_retry',
}

/**
 * Result of a sequential agent run
 */
export interface RunResult {
    status: RunStatus;
    response: string;
    next?: string; // Optional name of the next agent to run
    metadata?: any;
}

/**
 * Configuration for individual runner stages
 */
export interface RunnerStageConfig {
    input?: (
        history: ResponseInput,
        lastOutput: Record<string, string>
    ) => ResponseInput; // Prepares the input for the agent based on past conversation history

    agent: () => any;

    next: (output: string) => string | null; // Determines the next stage based on the output. Null if this is the last stage
}

/**
 * Complete configuration for runner stages
 */
export type RunnerConfig = {
    [stage: string]: RunnerStageConfig;
};

/**
 * Model provider interface
 */
export interface ModelProvider {
    createResponseStream(
        model: string,
        messages: ResponseInput,
        agent: any
    ): AsyncGenerator<StreamingEvent>;
}

/**
 * Model class identifier
 */
export type ModelClassID =
    | 'standard'
    | 'mini'
    | 'reasoning'
    | 'reasoning_mini'
    | 'monologue'
    | 'metacognition'
    | 'code'
    | 'writing'
    | 'summary'
    | 'vision'
    | 'vision_mini'
    | 'search'
    | 'image_generation'
    | 'embedding';

// --- Custom Signals for Task Flow Control ---

/**
 * Custom error used as a signal to indicate successful task completion.
 * This allows the runner to stop processing immediately when this tool is called.
 */
export class TaskCompleteSignal extends Error {
    public readonly result: string;
    public history?: ResponseInput | undefined;
    constructor(result: string) {
        super('Task completed successfully.');
        this.name = 'TaskCompleteSignal';
        this.result = result;
        // Ensure the prototype chain is set correctly for instanceof checks
        Object.setPrototypeOf(this, TaskCompleteSignal.prototype);
    }
}

/**
 * Custom error used as a signal to indicate a fatal task error.
 * This allows the runner to stop processing immediately when this tool is called.
 */
export class TaskFatalErrorSignal extends Error {
    public readonly errorDetails: string;
    public history?: ResponseInput | undefined;
    constructor(errorDetails: string) {
        super('Task failed due to a fatal error.');
        this.name = 'TaskFatalErrorSignal';
        this.errorDetails = errorDetails;
        // Ensure the prototype chain is set correctly for instanceof checks
        Object.setPrototypeOf(this, TaskFatalErrorSignal.prototype);
    }
}

// ======================================================================
// UNIFIED MESSAGING SYSTEM
// ======================================================================

/**
 * Direction of message flow between system components
 */
export type MessageDirection =
    | 'process->server' // From Magi Process to Controller Server (via WebSocket)
    | 'server->process' // From Controller Server to Magi Process (via WebSocket)
    | 'server->client' // From Controller Server to Controller Client (via Socket.IO)
    | 'client->server'; // From Controller Client to Controller Server (via Socket.IO)

/**
 * Client-to-server message types (extending existing StreamEventType)
 */
export type ClientServerMessageType =
    | 'CLIENT_COMMAND_RUN' // Run a new command
    | 'CLIENT_PROCESS_TERMINATE' // Terminate a process
    | 'CLIENT_PROCESS_COMMAND' // Send a command to a specific process
    | 'CLIENT_SET_PAUSE_STATE' // Set system pause state
    | 'CLIENT_SET_UIMODE_STATE' // Change UI mode
    | 'CLIENT_SET_AUDIO_STATE' // Toggle audio
    | 'CLIENT_SET_TELEGRAM_STATE' // Toggle Telegram
    | 'CLIENT_UPDATE_APP_SETTINGS'; // Update all app settings at once

/**
 * All possible message types
 */
export type MessageType = StreamEventType | ClientServerMessageType;

/**
 * Client->Server message payloads
 */
export interface ClientCommandRunPayload {
    command: string;
}

export interface ClientProcessTerminatePayload {
    processId: string;
}

export interface ClientProcessCommandPayload {
    processId: string;
    command: string;
    sourceProcessId?: string;
}

export interface ClientSetPauseStatePayload {
    pauseState: boolean;
}

export interface ClientSetUIModeStatePayload {
    uiMode: 'column' | 'canvas';
}

export interface ClientSetAudioStatePayload {
    audioState: boolean;
}

export interface ClientSetTelegramStatePayload {
    telegramState: boolean;
}

export interface ClientUpdateAppSettingsPayload {
    settings: AppSettings;
}

/**
 * Maps MessageType to its specific payload type
 */
export type MessagePayloads = {
    // Process->Server & Server->Client payloads (using existing event interfaces)
    connected: Omit<ConnectedEvent, 'type'>;
    command_start: Omit<CommandEvent, 'type'>;
    command_done: Omit<CommandEvent, 'type'>;
    project_create: Omit<ProjectEvent, 'type'>;
    project_update: Omit<ProjectEvent, 'type'>;
    process_start: Omit<ProcessEvent, 'type'>;
    process_running: Omit<ProcessEvent, 'type'>;
    process_updated: Omit<ProcessEvent, 'type'>;
    process_done: Omit<ProcessEvent, 'type'>;
    process_failed: Omit<ProcessEvent, 'type'>;
    process_waiting: Omit<ProcessEvent, 'type'>;
    process_terminated: Omit<ProcessEvent, 'type'>;
    agent_start: Omit<AgentEvent, 'type'>;
    agent_updated: Omit<AgentEvent, 'type'>;
    agent_done: Omit<AgentEvent, 'type'>;
    message_start: Omit<MessageEvent, 'type'>;
    message_delta: Omit<MessageEvent, 'type'>;
    message_complete: Omit<MessageEvent, 'type'>;
    talk_start: Omit<TalkEvent, 'type'>;
    talk_delta: Omit<TalkEvent, 'type'>;
    talk_complete: Omit<TalkEvent, 'type'>;
    audio_stream: Omit<AudioEvent, 'type'>;
    tool_start: Omit<ToolEvent, 'type'>;
    tool_delta: Omit<ToolEvent, 'type'>;
    tool_done: Omit<ToolEvent, 'type'>;
    file_start: Omit<FileEvent, 'type'>;
    file_delta: Omit<FileEvent, 'type'>;
    file_complete: Omit<FileEvent, 'type'>;
    cost_update: Omit<CostUpdateEvent, 'type'>;
    system_status: Omit<SystemStatusEvent, 'type'>;
    quota_update: Omit<QuotaUpdateEvent, 'type'>;
    screenshot: Omit<ScreenshotEvent, 'type'>;
    design_grid: Omit<DesignGridEvent, 'type'>;
    error: Omit<ErrorEvent, 'type'>;
    // Add new wait events
    tool_wait_start: Omit<ToolWaitStartEvent, 'type'>;
    tool_waiting: Omit<ToolWaitingEvent, 'type'>;
    tool_wait_complete: Omit<ToolWaitCompleteEvent, 'type'>;
    task_wait_start: Omit<TaskWaitStartEvent, 'type'>;
    task_waiting: Omit<TaskWaitingEvent, 'type'>;
    task_wait_complete: Omit<TaskWaitCompleteEvent, 'type'>;

    // Client->Server payloads
    CLIENT_COMMAND_RUN: ClientCommandRunPayload;
    CLIENT_PROCESS_TERMINATE: ClientProcessTerminatePayload;
    CLIENT_PROCESS_COMMAND: ClientProcessCommandPayload;
    CLIENT_SET_PAUSE_STATE: ClientSetPauseStatePayload;
    CLIENT_SET_UIMODE_STATE: ClientSetUIModeStatePayload;
    CLIENT_SET_AUDIO_STATE: ClientSetAudioStatePayload;
    CLIENT_SET_TELEGRAM_STATE: ClientSetTelegramStatePayload;
    CLIENT_UPDATE_APP_SETTINGS: ClientUpdateAppSettingsPayload;
};

// Event types
export interface MagiMessage {
    processId: string;
    event: StreamingEvent;
}

export interface ServerMessage {
    type:
        | 'command'
        | 'connect'
        | 'process_event'
        | 'project_update'
        | 'system_message'
        | 'system_command';
}

export interface CommandMessage extends ServerMessage {
    type: 'command' | 'connect';
    command: string;
    args?: {
        sourceProcessId?: string; // Added for process-to-process communication
        [key: string]: any;
    };
}

export interface ProjectMessage extends ServerMessage {
    type: 'project_update';
    project_id: string;
    message: string;
    failed?: boolean;
}

export interface SystemMessage extends ServerMessage {
    type: 'system_message';
    message: string;
}

export interface SystemCommandMessage extends ServerMessage {
    type: 'system_command';
    command: string;
}

export interface ProcessEventMessage extends ServerMessage {
    type: 'process_event';
    processId: string;
    event: StreamingEvent;
}

export interface ContainerConnection {
    processId: string;
    lastMessage: Date;
    messageHistory: MagiMessage[];
}

// Event handler type
export type EventHandler = (
    event: any,
    sourceProcessId?: string
) => Promise<any>;

export type MergePolicy = 'none' | 'low_risk' | 'moderate_risk' | 'all';
export type MergeAction = 'merge' | 'push_only';

export interface RiskBreakdown {
    totalRiskScore: number;
    pathRisk: string[];
    typeRisk: string[];
    patternRisk: string[];
    dependencyFileChanged: boolean;
    allowListed: boolean;
}

/**
 * Change‑set metrics returned by computeMetrics().
 * All fields are normalised to the branch‑vs‑main diff (not HEAD~1).
 */
export interface Metrics {
    /* raw size / scope */
    filesChanged: number;
    totalLines: number;
    directoryCount: number;
    hunks: number;

    /* dispersion / complexity */
    entropyNormalised: number; // 0–1
    churnRatio: number; // ≥1  (adds+dels / adds)
    cyclomaticDelta: number; // ∑ΔCC across modified functions (fallback 0)

    /* developer & history */
    developerUnfamiliarity: number; // 0–1 (1 = author never touched these files)

    /* content / pattern flags */
    secretRegexHits: number;
    apiSignatureEdits: number;
    controlFlowEdits: number;

    /* legacy risk breakdown (still useful) */
    risk: RiskBreakdown;

    /**
     * Weighted risk score in the range 0‑1; higher = riskier.
     *   score <= LOW_RISK_MAX    ⇒ "low"
     *   score <= MOD_RISK_MAX    ⇒ "moderate"
     *   else                     ⇒ "high"
     */
    score: number;
}
