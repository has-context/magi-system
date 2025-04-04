/**
 * Common type definitions for the MAGI system.
 */
import {Agent} from './utils/agent.js';
import {ModelClassID} from './model_providers/model_data.js';

declare global {
	namespace NodeJS {
		interface ProcessEnv {
			NODE_ENV: 'development' | 'production';
			PROCESS_ID: string;
			CONTROLLER_PORT: string;
			HOST_HOSTNAME: string;
			OPENAI_API_KEY?: string;
			ANTHROPIC_API_KEY?: string;
			GOOGLE_API_KEY?: string;
			XAI_API_KEY?: string;
			DEEPSEEK_API_KEY?: string;
			BRAVE_API_KEY?: string;
			PROJECT_REPOSITORIES?: string;
		}
	}
}

// Define the Agent interface to avoid circular dependency
export interface AgentInterface {
    agent_id: string;
    name: string;
    description: string;
    instructions: string;
    parent?: AgentInterface;
    workers?: AgentInterface[];
    tools?: ToolFunction[];
    model?: string;
    modelClass?: string;
    modelSettings?: ModelSettings;
    maxToolCalls?: number;
    onToolCall?: (toolCall: ToolCall) => void;
    onToolResult?: (toolCall: ToolCall, result: string) => void;
    export(): AgentExportDefinition;
    asTool(): ToolFunction;
}

export interface AgentProcess {
	processId: string;
	started: Date;
	status: 'started' | 'running' | 'waiting' | 'completed' | 'terminated';
	tool: ProcessToolType;
	command: string;
	name: string;
	output?: string;
	history?: ResponseInput;
	project?: string[]; // List of git repositories to mount
}

export type ToolParameterType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null';
export const validToolParameterTypes: ToolParameterType[] = ['string', 'number', 'boolean', 'object', 'array', 'null'];

/**
 * Tool parameter type definitions using strict schema format for OpenAI function calling
 */
export interface ToolParameter {
	type: ToolParameterType;
	description?: string;
	enum?: string[];
	items?: ToolParameter | { type: ToolParameterType, enum?: string[] };
	properties?: Record<string, ToolParameter>;
	required?: string[];

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
	maxToolCalls?: number;

	onToolCall?: (toolCall: ToolCall) => Promise<void>;
	onToolResult?: (toolCall: ToolCall, result: string) => Promise<void>;
	onRequest?: (messages: ResponseInput, model: string) => Promise<[ResponseInput, string, number]>;
	onResponse?: (response: string) => Promise<string>;
}

/**
 * Definition-exportable version of the agent
 */
export interface AgentExportDefinition {
	agent_id: string;
	name: string;
	parent?: AgentExportDefinition;
	model?: string;
	modelClass?: string;
}

/**
 * Model settings for the OpenAI API
 */
export interface ModelSettings {
	temperature?: number;
	top_p?: number;
	max_tokens?: number;
	seed?: number;
	response_format?: { type: string };
	tool_choice?: 'auto' | 'none' | 'required' | { type: string; function: { name: string } };
}

/**
 * Tool call data structure
 */
export interface ToolCall {
	id: string;
	type: 'function';
	function: {
		name: string;
		arguments: string;
	};
}

export interface ToolCallHandler {
	onToolCall?: (toolCall: ToolCall) => void,
	onToolResult?: (toolCall: ToolCall, result: string) => void,
	onEvent?: (event: StreamingEvent) => void,
	onResponse?: (content: string) => void,
	onComplete?: () => void
}




export interface ResponseContentText {
	type: 'input_text',
	text: string,
}

export interface ResponseContentImage {
	type: 'input_image',
	detail: 'high' | 'low' | 'auto',
	file_id?: string,
	image_url?: string,
}

export interface ResponseContentFileInput {
	type: 'input_file',
	file_data?: string,
	file_id?: string,
	filename?: string,
}

/**
 * ResponseContent
 */
export type ResponseContent = string | Array<ResponseContentText | ResponseContentImage | ResponseContentFileInput>;


/**
 * ResponseInput
 */
export type ResponseInput = Array<ResponseInputItem>;
export type ResponseInputItem = ResponseInputMessage | ResponseOutputMessage | ResponseInputFunctionCall | ResponseInputFunctionCallOutput;


/**
 * ResponseInputMessage
 */
export interface ResponseInputMessage {
	type?: 'message',
	name?: string, // deprecated
	content: ResponseContent,
	role: 'user' | 'system' | 'developer',
	status?: 'in_progress' | 'completed' | 'incomplete',
}

/**
 * ResponseInputMessage
 */
export interface ResponseOutputMessage {
	type: 'message',
	content: ResponseContent,
	role: 'assistant',
	status: 'in_progress' | 'completed' | 'incomplete',
}

/**
 * Tool call data structure
 */
export interface ResponseInputFunctionCall {
	type: 'function_call',
	call_id: string,
	name: string,
	arguments: string,
	id?: string,
	status?: 'in_progress' | 'completed' | 'incomplete',
}

/**
 * Tool call data structure
 */
export interface ResponseInputFunctionCallOutput {
	type: 'function_call_output',
	call_id: string,
	name: string,
	output: string,
	id?: string,
	status?: 'in_progress' | 'completed' | 'incomplete',
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
	'connected'
	| 'command_start'
	| 'command_done'
	| 'project_create'
	| 'project_ready'
	| 'process_start'
	| 'process_running'
	| 'process_updated'
	| 'process_done'
	| 'process_terminated'
	| 'agent_start'
	| 'agent_updated'
	| 'agent_done'
	| 'message_start'
	| 'message_delta'
	| 'message_complete'
	| 'talk_start'
	| 'talk_delta'
	| 'talk_complete'
	| 'tool_start'
	| 'tool_delta'
	| 'tool_done'
	| 'file_start'
	| 'file_delta'
	| 'file_complete'
	| 'cost_update'
	| 'error';

/**
 * Base streaming event interface
 */
export interface StreamEvent {
	type: StreamEventType;
	agent?: AgentExportDefinition;
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
	processId: string;
	command: string;
}

/**
 * Project updated streaming event
 */
export interface ProjectEvent extends StreamEvent {
	type: 'project_create' | 'project_ready';
	project: string;
}


export type ProcessToolType = 'research_engine' | 'godel_machine' | 'task_force';

/**
 * Agent updated streaming event
 */
export interface ProcessEvent extends StreamEvent {
	type: 'process_start' | 'process_running' | 'process_updated' | 'process_done' | 'process_terminated';
	agentProcess?: AgentProcess;
	output?: string;
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
 * Message streaming event
 */
export interface MessageEvent extends StreamEvent {
	type: 'message_start' | 'message_delta' | 'message_complete'; // Changed 'message_done' to 'message_complete'
	content: string;
	message_id: string; // Added message_id for tracking deltas and completes
	order?: number; // Optional order property for message sorting
}

/**
 * Message streaming event
 */
export interface FileEvent extends StreamEvent {
	type: 'file_start' | 'file_delta' | 'file_complete'; // Changed 'message_done' to 'message_complete'
	message_id: string; // Added message_id for tracking deltas and completes
	mime_type?: string;
	data_format: 'base64';
	data: string;
	order?: number; // Optional order property for message sorting
}

/**
 * Message streaming event
 */
export interface TalkEvent extends StreamEvent {
	type: 'talk_start' | 'talk_delta' | 'talk_complete';
	content: string;
	message_id: string; // Added message_id for tracking deltas and completes
	order?: number; // Optional order property for message sorting
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
 * Cost update streaming event
 */
export interface CostUpdateEvent extends StreamEvent {
	type: 'cost_update';
	totalCost: number;
	modelCosts: Record<string, { cost: number; calls: number; }>;
	timestamp: string;
	thoughtLevel?: number;
	delay?: number;
}

/**
 * Union type for all streaming events
 */
export type StreamingEvent = ConnectedEvent | CommandEvent | ProjectEvent | ProcessEvent | AgentEvent | MessageEvent | FileEvent | TalkEvent | ToolEvent | ErrorEvent | CostUpdateEvent;

/**
 * Status of a sequential agent run
 */
export enum RunStatus {
	SUCCESS = 'success',
	FAILURE = 'failure',
	NEEDS_RETRY = 'needs_retry'
}

/**
 * Result of a sequential agent run
 */
export interface RunResult {
	status: RunStatus;
	response: string;
	next?: string; // Optional name of the next agent to run
	metadata?: any; // Optional metadata to pass to the next agent
}

/**
 * Configuration for individual runner stages
 */
export interface RunnerStageConfig {
	input?: (history: ResponseInput, lastOutput: Record<string, string>) => ResponseInput; // Prepares the input for the agent based on past conversation history

	agent: () => Agent; // Returns the agent for this stage

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
		agent?: Agent,
	): AsyncGenerator<StreamingEvent>;
}
