/**
 * Shared type definitions for the MAGI System
 * Used by both client and server
 */

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
			PROJECT_PARENT_PATH?: string;
			PROJECT_REPOSITORIES?: string;
		}
	}
}
// Define types for communication with magi containers
export type StreamEventType =
    'connected'
    | 'command_start'
    | 'command_done'
    | 'agent_start'
    | 'agent_updated'
    | 'agent_done'
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
    | 'cost_update'
    | 'error';

// Basic agent definition for messages
export interface AgentExportDefinition {
    agent_id: string;
    name: string;
    parent?: AgentExportDefinition;
	model?: string;
	modelClass?: string;
}

// Basic tool call interface
export interface ToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}

// Base streaming event interface
export interface StreamEvent {
    type: StreamEventType;
    agent?: AgentExportDefinition;
    timestamp?: string;
}

// Connected event
export interface ConnectedEvent extends StreamEvent {
    type: 'connected';
    timestamp: string;
}

// Command event
export interface CommandEvent extends StreamEvent {
    type: 'command_start' | 'command_done';
    command: string;
}

// Agent event
export interface AgentEvent extends StreamEvent {
    type: 'agent_start' | 'agent_updated' | 'agent_done';
    agent: AgentExportDefinition;
    input?: string;
}

// Message event
export interface MessageEvent extends StreamEvent {
    type: 'message_start' | 'message_delta' | 'message_complete';
    content: string;
    message_id: string;
    order?: number;
    thinking?: string;
}

/**
 * Message streaming event
 */
export interface AudioEvent extends StreamEvent {
	type: 'audio_stream';
	timestamp: string;
	chunkIndex?: number;
	isFinalChunk?: boolean;
	data?: string;
	format?: string;
	pcmParameters?: any;
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

// Tool event
export interface ToolEvent extends StreamEvent {
    type: 'tool_start' | 'tool_delta' | 'tool_done';
    tool_calls: ToolCall[];
    results?: any;
    tool?: string;
    params?: any;
    data?: any;
    result?: any;
}

// Cost update event
export interface CostUpdateEvent extends StreamEvent {
    type: 'cost_update';
    totalCost: number;
    modelCosts: Record<string, { cost: number; calls: number; }>;
    thoughtLevel?: number;
    delay?: number;
}

// Error event
export interface ErrorEvent extends StreamEvent {
    type: 'error';
    error: string;
}

// Union type for all streaming events
export type StreamingEvent = ConnectedEvent | CommandEvent | AgentEvent | MessageEvent | TalkEvent | AudioEvent | ToolEvent | CostUpdateEvent | ErrorEvent;

/**
 * MagiMessage format for communication between containers and controller
 */
export interface MagiMessage {
	processId: string;
	event: StreamingEvent;
}

// Process status type
export type ProcessStatus = 'running' | 'completed' | 'failed' | 'terminated' | 'ending';

// Cost tracking interfaces
export interface ModelCostSummary {
	model: string;
	cost: number;
	calls: number;
}

export interface CostData {
	totalCost: number;
	costPerMinute: number;
	modelCosts: ModelCostSummary[];
	numProcesses: number;
	thoughtLevel?: number;
	delay?: number;
	timestamp: number;
}

// Socket.io event interfaces

// Event sent when a new process is created
export interface ProcessCreateEvent {
	id: string;           // Process ID
	command: string;      // Command that created the process
	name: string;
	status: ProcessStatus;       // Initial status (usually 'running')
	colors: {
		rgb: string;		// Primary color (rgb)
		bgColor: string;	// Background color (rgba)
		textColor: string;	// Text color (rgba)
	};
}

// Event sent when new logs are available for a process
export interface ProcessLogsEvent {
	id: string;           // Process ID
	logs: string;         // Log content (may include markdown)
}

// Event sent when a structured message from a MAGI container is available
export interface ProcessMessageEvent {
	id: string;           // Process ID
	message: MagiMessage; // Structured message from the container
}

// Event sent when a process status changes
export interface ProcessUpdateEvent {
	id: string;           // Process ID
	status: ProcessStatus;       // New status
}

// Event for sending a command to a specific process
export interface ProcessCommandEvent {
	processId: string;    // Target process ID
	command: string;      // Command to send
	sourceProcessId?: string; // Optional source process ID for process-to-process communication
}

// Event for server information sent to clients
export interface ServerInfoEvent {
	version: string;      // Server version
}

// Event for cost information sent to clients
export interface CostInfoEvent {
	cost: CostData;       // Cost information
}

// Position for absolute positioning of boxes
export interface BoxPosition {
    x: number;
    y: number;
    width: number;
	height: number;
	scale: number;
}

// Client-side DOM element references for processes
export interface ProcessElement {
    box: HTMLElement;      // Container element
    logs: HTMLElement;     // Log output container
    status: HTMLElement;   // Status indicator
    input?: HTMLInputElement; // Optional process-specific input field
}
