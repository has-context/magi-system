import * as React from 'react';
import {
    createContext,
    useContext,
    useState,
    useEffect,
    ReactNode,
} from 'react';
import io from 'socket.io-client';
import {
    ProcessCreateEvent,
    ProcessLogsEvent,
    ProcessUpdateEvent,
    ProcessCommandEvent,
    ProcessMessageEvent,
    ProcessStatus,
    GlobalCostData,
    AppSettings,
    ScreenshotEvent,
    ConsoleEvent,
    DesignEvent,
    AgentStatusEvent,
    AudioEvent,
} from '../../../types/shared-types';
// Comment out direct import - we'll use simpler approach to avoid TypeScript errors
// import { ContainerConnection, MagiMessage } from '../../../server/managers/communication_manager';
import { handleAudioMessage, stopAudio } from '../utils/AudioUtils';

// Define the type for the Socket.io socket
// Using a basic interface for Socket.io instance
interface Socket {
    emit: (event: string, ...args: unknown[]) => void;
    on: (event: string, callback: (...args: unknown[]) => void) => void;
    disconnect: () => void;
}

// Define message interfaces for the chat UI
export interface PartialClientMessage {
    id?: string; // Generated UUID for the message
    agent?: AgentData;
    processId?: string; // Process ID this message belongs to
    type?:
        | 'user'
        | 'assistant'
        | 'system'
        | 'tool_call'
        | 'tool_result'
        | 'error';
    content?: string;
    thinking_content?: string;
    timestamp?: string;
    rawEvent?: unknown; // Store the raw event data for debugging
    message_id?: string; // Original message_id from the LLM for delta/complete pairs
    isDelta?: boolean; // Flag to indicate if this is a delta message that will be replaced by a complete
    order?: number; // Order position for delta messages
    deltaChunks?: { [order: number]: string }; // Storage for message delta chunks
    deltaThinkingChunks?: { [order: number]: string }; // Storage for message delta chunks
}

// Define message interfaces for the chat UI
export interface ClientMessage {
    id: string; // Generated UUID for the message
    agent?: AgentData;
    processId: string; // Process ID this message belongs to
    type:
        | 'user'
        | 'assistant'
        | 'system'
        | 'tool_call'
        | 'tool_result'
        | 'error';
    content: string;
    thinking_content?: string;
    timestamp: string;
    rawEvent?: unknown; // Store the raw event data for debugging
    message_id?: string; // Original message_id from the LLM for delta/complete pairs
    isDelta?: boolean; // Flag to indicate if this is a delta message that will be replaced by a complete
    order?: number; // Order position for delta messages
    deltaChunks?: { [order: number]: string }; // Storage for message delta chunks
    deltaThinkingChunks?: { [order: number]: string }; // Storage for message delta chunks
}

export interface ToolCallMessage extends ClientMessage {
    type: 'tool_call';
    toolName: string;
    toolCallId: string;
    toolParams: Record<string, unknown>;
    command?: string; // The equivalent shell command if applicable
}

export interface ToolResultMessage extends ClientMessage {
    type: 'tool_result';
    toolName: string;
    toolCallId: string;
    result: unknown;
}

// Define the context interface
interface SocketContextInterface {
    socket: Socket | null;
    runCommand: (command: string) => void;
    sendProcessCommand: (processId: string, command: string) => void;
    sendCoreCommand: (command: string) => void;
    terminateProcess: (processId: string) => void;
    processes: Map<string, ProcessData>;
    serverVersion: string | null;
    coreProcessId: string | null;
    systemStatus: string | null;
    costData: GlobalCostData | null;
    isPaused: boolean;
    togglePauseState: () => void;
    uiMode: string;
    toggleUIMode: () => void;
    isAudioEnabled: boolean;
    toggleAudioState: () => void;
    isTelegramEnabled: boolean;
    toggleTelegramState: () => void;
}

export interface AgentData {
    agent_id?: string;
    name: string;
    parent?: AgentData;
    workers?: Map<string, AgentData>; // Map of workers by their agent_id
    model?: string;
    modelClass?: string;
    messages: ClientMessage[]; // Store structured messages
    isTyping?: boolean; // Indicates if the agent is in "thinking" state
    screenshots?: ScreenshotEvent[]; // Store screenshots for this agent
    consoleEvents?: ConsoleEvent[]; // Store console data for this agent
    designEvents?: DesignEvent[]; // Store design images for this agent
    statusEvent?: AgentStatusEvent; // Store the last status event for this agent
}

// Define the process data structure
export interface ProcessData {
    id: string;
    name: string;
    command: string;
    status: ProcessStatus;
    colors: {
        rgb: string;
        bgColor: string;
        textColor: string;
    };
    logs: string;
    agent?: AgentData;
    pendingScreenshots: Map<string, ScreenshotEvent[]>;
    pendingConsoleEvents: Map<string, ConsoleEvent[]>;
    pendingDesignEvents: Map<string, DesignEvent[]>;
    pendingMessages: Map<string, PartialClientMessage[]>;
}

// Create the context with a default value
const SocketContext = createContext<SocketContextInterface>({
    socket: null,
    runCommand: () => {},
    sendProcessCommand: () => {},
    sendCoreCommand: () => {},
    terminateProcess: () => {},
    processes: new Map<string, ProcessData>(),
    serverVersion: null,
    coreProcessId: null,
    systemStatus: null,
    costData: null,
    isPaused: false,
    togglePauseState: () => {},
    uiMode: 'column',
    toggleUIMode: () => {},
    isAudioEnabled: true,
    toggleAudioState: () => {},
    isTelegramEnabled: true,
    toggleTelegramState: () => {},
});

// Define props for the provider
interface SocketProviderProps {
    children: ReactNode;
}

// Create a provider component
export const SocketProvider: React.FC<SocketProviderProps> = ({ children }) => {
    const [socket, setSocket] = useState<Socket | null>(null);
    const [processes, setProcesses] = useState<Map<string, ProcessData>>(
        new Map()
    );
    const [serverVersion, setServerVersion] = useState<string | null>(null);
    const [coreProcessId, setCoreProcessId] = useState<string | null>(null);
    const [systemStatus, setSystemStatus] = useState<string | null>(null);
    const [costData, setCostData] = useState<GlobalCostData | null>(null);
    const [isPaused, setIsPaused] = useState<boolean>(false);
    const [uiMode, setUiMode] = useState<'canvas' | 'column'>('column');
    const [isAudioEnabled, setIsAudioEnabled] = useState<boolean>(true);
    const [isTelegramEnabled, setIsTelegramEnabled] = useState<boolean>(true);

    // Initialize socket connection
    useEffect(() => {
        // Cast to Socket type since we know the interface matches our needs
        const socketInstance = io() as unknown as Socket;
        setSocket(socketInstance);

        // Note: An API endpoint has been created at /api/processes
        // to fetch all active processes and their state from the server.
        // This will allow you to fetch process history when client reconnects.
        // It could be integrated here to load processes on initial connection.

        // Set up event listeners
        socketInstance.on('server:info', (data: { version: string }) => {
            // If we have a previous version and it's different from current version,
            // and this is a server restart, reload the page to get the latest code
            if (serverVersion && serverVersion !== data.version) {
                console.log(
                    'Server was restarted. Reloading page to get latest code...'
                );
                window.location.reload();
                return;
            }

            setServerVersion(data.version);
        });

        // Handle cost information updates
        socketInstance.on('cost:info', (costData: GlobalCostData) => {
            console.log('***Received cost:info', costData);
            setCostData(costData);
        });

        // Handle cost information updates
        socketInstance.on('system:status', (systemStatus: string) => {
            console.log('***Received system:status', systemStatus);
            setSystemStatus(systemStatus);
        });

        setSystemStatus;

        // Handle pause state updates from the server
        socketInstance.on('pause_state_update', (pauseState: boolean) => {
            console.log(`Received pause_state_update: ${pauseState}`);
            setIsPaused(pauseState);
        });

        // Handle uimode updates from the server
        socketInstance.on(
            'uimode_state_update',
            (uiMode: 'canvas' | 'column') => {
                console.log(`Received uimode_state_update: ${uiMode}`);
                setUiMode(uiMode);
            }
        );

        // Handle audio state updates from the server
        socketInstance.on('audio_state_update', (audioState: boolean) => {
            console.log(`Received audio_state_update: ${audioState}`);
            setIsAudioEnabled(audioState);
        });

        // Handle telegram state updates from the server
        socketInstance.on('telegram_state_update', (telegramState: boolean) => {
            console.log(`Received telegram_state_update: ${telegramState}`);
            setIsTelegramEnabled(telegramState);
        });

        // Handle complete app settings updates from the server
        socketInstance.on('app_settings_update', (settings: AppSettings) => {
            console.log(`Received app_settings_update:`, settings);

            // Apply all settings
            if (settings.uiMode) {
                // The UI mode will be handled by the App component
                console.log(`UI mode set to: ${settings.uiMode}`);
            }

            if (typeof settings.isAudioEnabled === 'boolean') {
                setIsAudioEnabled(settings.isAudioEnabled);
            }

            if (typeof settings.isTelegramEnabled === 'boolean') {
                setIsTelegramEnabled(settings.isTelegramEnabled);
            }
        });

        socketInstance.on('process:create', (event: ProcessCreateEvent) => {
            setProcesses(prevProcesses => {
                const newProcesses = new Map(prevProcesses);

                // Create initial user message from the command
                const initialMessage: ClientMessage = {
                    id: generateId(),
                    processId: event.id,
                    type: 'user',
                    content: event.command,
                    timestamp: new Date().toISOString(),
                };

                newProcesses.set(event.id, {
                    id: event.id,
                    command: event.command,
                    status: event.status,
                    colors: event.colors,
                    logs: '',
                    name: event.name,
                    agent: {
                        name: event.name,
                        messages: [initialMessage],
                        isTyping: true,
                        workers: new Map<string, AgentData>(),
                    },
                    pendingScreenshots: new Map<string, ScreenshotEvent[]>(),
                    pendingConsoleEvents: new Map<string, ConsoleEvent[]>(),
                    pendingDesignEvents: new Map<string, DesignEvent[]>(),
                    pendingMessages: new Map<string, PartialClientMessage[]>(),
                });

                // Set the core process ID if this is the first process created
                if (newProcesses.size === 1 || !coreProcessId) {
                    setCoreProcessId(event.id);
                    console.log(`Setting core process ID to ${event.id}`);
                }

                return newProcesses;
            });
        });

        // Helper function to generate unique IDs
        const generateId = (): string => {
            return (
                Math.random().toString(36).substring(2, 15) +
                Math.random().toString(36).substring(2, 15)
            );
        };

        // Still keep the logs event for basic log information (non-JSON)
        socketInstance.on('process:logs', (event: ProcessLogsEvent) => {
            setProcesses(prevProcesses => {
                const newProcesses = new Map(prevProcesses);
                const process = newProcesses.get(event.id) as
                    | ProcessData
                    | undefined;
                if (!process) return newProcesses;

                // Add the raw logs
                const updatedLogs = process.logs + event.logs;

                // Update the process with new logs only
                newProcesses.set(event.id, {
                    ...process,
                    logs: updatedLogs,
                });

                return newProcesses;
            });
        });

        // Handle structured messages from containers via the dedicated channel
        socketInstance.on('process:message', (event: ProcessMessageEvent) => {
            if (
                event.message &&
                (!event.message.event.type ||
                    ![
                        'message_delta',
                        'console',
                        'tool_delta',
                        'quota_update',
                        'cost_update',
                    ].includes(event.message.event.type))
            ) {
                console.log(
                    `process:message`,
                    event.id,
                    event.message.event.type,
                    event.message
                );
            }

            setProcesses(prevProcesses => {
                const newProcesses = new Map(prevProcesses);
                const process = newProcesses.get(event.id) as
                    | ProcessData
                    | undefined;

                if (!process) return newProcesses;

                // Use the imported MagiMessage structure
                const data = event.message;
                const streamingEvent = data.event;
                // Use timestamp if it exists, otherwise use current time
                const timestamp =
                    (streamingEvent as { timestamp?: string }).timestamp ||
                    new Date().toISOString();
                const eventType = streamingEvent.type;

                function updateAgent(
                    values: Record<string, unknown>,
                    agent_id?: string,
                    agent?: AgentData
                ): AgentData | undefined {
                    agent_id = agent_id || streamingEvent.agent?.agent_id;
                    if (!agent_id) return;

                    const updatedAgent = agent || process.agent!;
                    if (updatedAgent.agent_id === agent_id) {
                        Object.assign(updatedAgent, values);
                    } else if (updatedAgent.workers) {
                        const updatedWorkers = new Map();
                        updatedAgent.workers.forEach((worker, workerId) => {
                            const updatedAgent = updateAgent(
                                values,
                                agent_id,
                                worker
                            );
                            if (updatedAgent) {
                                updatedWorkers.set(workerId, updatedAgent);
                            }
                        });
                        updatedAgent.workers = updatedWorkers;
                    }
                    if (!agent) {
                        process.agent = updatedAgent;
                    }
                    return updatedAgent;
                }

                function addMessage(
                    message: ClientMessage,
                    agent_id?: string,
                    agent?: AgentData
                ): AgentData | undefined {
                    agent_id = agent_id || streamingEvent.agent?.agent_id;
                    if (!agent_id) return agent;

                    const updatedAgent = agent || process.agent!;
                    if (updatedAgent.agent_id === agent_id) {
                        if (!message.agent) {
                            message.agent = { ...updatedAgent }; // Save a copy of the agent for this particular message
                        }
                        updatedAgent.messages.push(message);
                    } else if (updatedAgent.workers) {
                        const updatedWorkers = new Map();
                        updatedAgent.workers.forEach((worker, workerId) => {
                            const newMessage = addMessage(
                                message,
                                agent_id,
                                worker
                            );
                            if (newMessage) {
                                updatedWorkers.set(workerId, newMessage);
                            }
                        });
                        updatedAgent.workers = updatedWorkers;
                    }
                    if (!agent) {
                        process.agent = updatedAgent;
                    }
                    return updatedAgent;
                }

                function completeMessage(
                    message: PartialClientMessage
                ): ClientMessage {
                    return {
                        id: generateId(),
                        processId: event.id,
                        type: message.type || 'system',
                        content: message.content || '',
                        thinking_content: message.thinking_content || '',
                        timestamp: message.timestamp || timestamp,
                        rawEvent: message.rawEvent || data,
                        ...message,
                    } as ClientMessage;
                }

                // Utility function to queue pending data when agent isn't available yet
                function queuePending<T>(
                    map: Map<string, T[]>,
                    agent_id: string | undefined,
                    item: T
                ): void {
                    if (!agent_id) return;
                    const list = map.get(agent_id) || [];
                    map.set(agent_id, [...list, item]);
                }

                // Utility to merge a screenshot into an agent with downsampling
                function mergeScreenshot(
                    targetAgent: AgentData,
                    screenshotEvent: ScreenshotEvent
                ): void {
                    // Create a new screenshots array immutably
                    let updatedScreenshots = [
                        ...(targetAgent.screenshots || []),
                        screenshotEvent,
                    ];

                    const RECENT_KEEP = 10; // always keep these newest frames
                    const HIST_EVERY = 5; // keep only every 5th older frame
                    const MAX_FRAMES = 25; // absolute cap

                    // Down‑sample when exceeding MAX_FRAMES
                    if (updatedScreenshots.length > MAX_FRAMES) {
                        const recent = updatedScreenshots.slice(-RECENT_KEEP);
                        const older = updatedScreenshots
                            .slice(0, -RECENT_KEEP)
                            .filter((_, idx) => idx % HIST_EVERY === 0);

                        updatedScreenshots = [...older, ...recent].slice(
                            -MAX_FRAMES
                        );
                    }

                    // Apply the updated screenshots to the agent
                    targetAgent.screenshots = updatedScreenshots;
                }

                // Utility to merge console data into an agent
                function mergeConsoleEvent(
                    targetAgent: AgentData,
                    consoleEvent: ConsoleEvent
                ): void {
                    // Create a new screenshots array immutably
                    const updatedConsoleEvents = [
                        ...(targetAgent.consoleEvents || []),
                        consoleEvent,
                    ];

                    // @todo how could we sample data here? I guess we would need to combine events - we can't just drop them because we need all historic data at each point

                    // Apply the updated screenshots to the agent
                    targetAgent.consoleEvents = updatedConsoleEvents;
                }

                // Utility to merge design data into an agent
                function mergeDesignEvent(
                    targetAgent: AgentData,
                    designEvent: DesignEvent
                ): void {
                    const updated = [
                        ...(targetAgent.designEvents || []),
                        designEvent,
                    ];
                    const MAX_FRAMES = 25;
                    if (updated.length > MAX_FRAMES) {
                        targetAgent.designEvents = updated.slice(-MAX_FRAMES);
                    } else {
                        targetAgent.designEvents = updated;
                    }
                }

                // Utility to flush pending screenshots for an agent
                function flushPending(agent_id: string): void {
                    // Find the target agent
                    const targetAgent =
                        process.agent!.agent_id === agent_id
                            ? process.agent!
                            : process.agent!.workers?.get(agent_id);

                    if (targetAgent) {
                        const pendingMessages =
                            process.pendingMessages.get(agent_id);
                        if (pendingMessages?.length > 0) {
                            pendingMessages.forEach(message => {
                                addMessage(
                                    completeMessage(message),
                                    agent_id,
                                    targetAgent
                                );
                            });
                            process.pendingMessages.delete(agent_id);
                        }

                        const pendingScreenshots =
                            process.pendingScreenshots.get(agent_id);
                        if (pendingScreenshots?.length > 0) {
                            pendingScreenshots.forEach(screenshotEvent => {
                                mergeScreenshot(targetAgent, screenshotEvent);
                            });
                            process.pendingScreenshots.delete(agent_id);
                        }

                        const pendingConsoleEvents =
                            process.pendingConsoleEvents.get(agent_id);
                        if (pendingConsoleEvents?.length > 0) {
                            pendingConsoleEvents.forEach(consoleEvent => {
                                mergeConsoleEvent(targetAgent, consoleEvent);
                            });
                            process.pendingConsoleEvents.delete(agent_id);
                        }

                        const pendingDesignEvents =
                            process.pendingDesignEvents.get(agent_id);
                        if (pendingDesignEvents?.length > 0) {
                            pendingDesignEvents.forEach(event => {
                                mergeDesignEvent(targetAgent, event);
                            });
                            process.pendingDesignEvents.delete(agent_id);
                        }
                    }
                }

                function addPartialMessage(
                    message: PartialClientMessage
                ): AgentData | undefined {
                    const agent_id = streamingEvent.agent?.agent_id;
                    const result = addMessage(completeMessage(message));

                    // If message couldn't be added to an agent (agent not found), queue it
                    if (!result && agent_id) {
                        queuePending(
                            process.pendingMessages,
                            agent_id,
                            message
                        );
                    }

                    return result;
                }

                // Handle different event types
                if (eventType === 'audio_stream') {
                    // Process audio data event for browser playback
                    if (isAudioEnabled) {
                        // Convert optional parameters to required ones for the AudioUtils handler
                        const audioEvent = streamingEvent as AudioEvent;
                        handleAudioMessage({
                            event: {
                                pcmParameters: audioEvent.pcmParameters
                                    ? {
                                          sampleRate:
                                              audioEvent.pcmParameters
                                                  .sampleRate || 44100,
                                          channels:
                                              audioEvent.pcmParameters
                                                  .channels || 1,
                                          bitDepth:
                                              audioEvent.pcmParameters
                                                  .bitDepth || 16,
                                      }
                                    : undefined,
                                data: audioEvent.data || '',
                                chunkIndex: audioEvent.chunkIndex || 0,
                                isFinalChunk: audioEvent.isFinalChunk || false,
                            },
                        });
                    }
                    return newProcesses; // No need to update the process state
                } else if (
                    eventType === 'command_start' ||
                    eventType === 'connected'
                ) {
                    // User message - already handled in process:create but good as a fallback
                    if ('command' in streamingEvent) {
                        const content = streamingEvent.command || '';
                        if (
                            content &&
                            !process.agent.messages.some(
                                m => m.type === 'user' && m.content === content
                            )
                        ) {
                            addPartialMessage({
                                type: 'user',
                                content: content,
                            });
                        }
                    }
                } else if (eventType === 'tool_start') {
                    // Tool call message
                    if ('tool_calls' in streamingEvent) {
                        const toolCalls = streamingEvent.tool_calls || [];
                        for (const toolCall of toolCalls) {
                            const toolName = toolCall.function.name;
                            let toolParams: Record<string, unknown> = {};
                            try {
                                toolParams = JSON.parse(
                                    toolCall.function.arguments
                                );
                            } catch (e) {
                                console.error(
                                    'Error parsing tool arguments:',
                                    e
                                );
                            }

                            // Generate command representation for certain tool types
                            let command: string = '';
                            ['prompt', 'input', 'command', 'message'].forEach(
                                (param: string) => {
                                    if (
                                        !command &&
                                        param in toolParams &&
                                        typeof toolParams[param] === 'string'
                                    ) {
                                        command = toolParams[param];
                                    }
                                }
                            );

                            addMessage({
                                id: generateId(),
                                processId: event.id,
                                type: 'tool_call',
                                content: `Using ${toolName}`,
                                timestamp: timestamp,
                                toolName: toolName,
                                toolCallId: toolCall.id,
                                toolParams: toolParams,
                                command: command,
                                rawEvent: data,
                            } as ToolCallMessage);
                        }
                    }
                } else if (eventType === 'tool_done') {
                    // Tool result message
                    if (
                        'tool_calls' in streamingEvent &&
                        'results' in streamingEvent
                    ) {
                        const toolCalls = streamingEvent.tool_calls || [];
                        const results = streamingEvent.results || {};

                        for (const toolCall of toolCalls) {
                            const toolName = toolCall.function.name;
                            const result = results[toolCall.id] || {};

                            addMessage({
                                id: generateId(),
                                processId: event.id,
                                type: 'tool_result',
                                content: `Result from ${toolName}`,
                                timestamp: timestamp,
                                toolName: toolName,
                                toolCallId: toolCall.id,
                                result: result,
                                rawEvent: data,
                            } as ToolResultMessage);
                        }
                    }
                } else if (
                    eventType === 'message_start' ||
                    eventType === 'message_delta' ||
                    eventType === 'message_complete' ||
                    eventType === 'talk_start' ||
                    eventType === 'talk_delta' ||
                    eventType === 'talk_complete' ||
                    eventType === 'system_update'
                ) {
                    // Assistant message
                    if ('message_id' in streamingEvent) {
                        const content = streamingEvent.content || '';
                        const thinking_content =
                            streamingEvent.thinking_content &&
                            streamingEvent.thinking_content !== '{empty}'
                                ? streamingEvent.thinking_content
                                : '';
                        const message_id = streamingEvent.message_id || '';

                        if ((content || thinking_content) && message_id) {
                            let existingMessage = undefined;
                            process.agent!.messages.forEach(message => {
                                if (message.message_id === message_id) {
                                    existingMessage = message;
                                }
                            });
                            if (!existingMessage && process.agent!.workers) {
                                process.agent!.workers.forEach(worker => {
                                    worker.messages.forEach(message => {
                                        if (message.message_id === message_id) {
                                            existingMessage = message;
                                        }
                                    });
                                });
                            }
                            const updatedMessage: PartialClientMessage = {
                                type: 'assistant',
                                content: content,
                                thinking_content: thinking_content,
                                message_id: message_id,
                                deltaChunks: {},
                                deltaThinkingChunks: {},
                                ...existingMessage,
                            };

                            // Handle streaming messages (delta/complete pairs)
                            if (eventType === 'message_delta') {
                                // Get order if available, otherwise default to 0
                                const order =
                                    'order' in streamingEvent
                                        ? Number(streamingEvent.order)
                                        : 0;
                                if (content)
                                    updatedMessage.deltaChunks[order] = content;
                                if (thinking_content)
                                    updatedMessage.deltaThinkingChunks[order] =
                                        thinking_content;
                                updatedMessage.isDelta = true;

                                if (existingMessage) {
                                    // Rebuild complete content from ordered chunks
                                    const orderedKeys = Object.keys(
                                        updatedMessage.deltaChunks
                                    )
                                        .map(Number)
                                        .sort((a, b) => a - b);

                                    // Update the displayed content
                                    updatedMessage.content = orderedKeys
                                        .map(
                                            key =>
                                                updatedMessage.deltaChunks![key]
                                        )
                                        .join('');

                                    const orderedThinkingKeys = Object.keys(
                                        updatedMessage.deltaThinkingChunks
                                    )
                                        .map(Number)
                                        .sort((a, b) => a - b);

                                    // Update the displayed thinking_content
                                    updatedMessage.thinking_content =
                                        orderedThinkingKeys
                                            .map(
                                                key =>
                                                    updatedMessage
                                                        .deltaThinkingChunks![
                                                        key
                                                    ]
                                            )
                                            .join('');
                                }
                            } else if (
                                (eventType === 'message_complete' ||
                                    eventType === 'talk_complete') &&
                                existingMessage
                            ) {
                                // Update the existing message in place
                                updatedMessage.content = content;
                                updatedMessage.thinking_content =
                                    thinking_content;
                                updatedMessage.isDelta = false;
                                updatedMessage.rawEvent = data;
                            }

                            if (existingMessage) {
                                // Update in agent's messages array
                                process.agent!.messages.forEach(
                                    (message, index) => {
                                        if (message.message_id === message_id) {
                                            process.agent!.messages[index] =
                                                completeMessage(updatedMessage);
                                        }
                                    }
                                );

                                // Update in workers' messages
                                if (process.agent!.workers) {
                                    // Correctly iterate over a Map
                                    process.agent!.workers.forEach(worker => {
                                        worker.messages.forEach(
                                            (message, messageIndex) => {
                                                if (
                                                    message.message_id ===
                                                    message_id
                                                ) {
                                                    worker.messages[
                                                        messageIndex
                                                    ] =
                                                        completeMessage(
                                                            updatedMessage
                                                        );
                                                }
                                            }
                                        );
                                    });
                                }
                            } else {
                                // If this is a new message, add it to the agent's messages
                                addPartialMessage(updatedMessage);
                            }
                        }
                    }
                } else if (
                    eventType === 'screenshot' ||
                    eventType === 'console' ||
                    eventType === 'design'
                ) {
                    // We call this a screenshot if it has the data property (for the base64 image)
                    // Access the screenshot properties using in-operator checks for type safety
                    const data = streamingEvent.data;
                    const agentInfo =
                        'agent' in streamingEvent
                            ? (streamingEvent.agent as { agent_id?: string })
                            : undefined;

                    // Get the agent to update with the screenshot
                    const agent_id = agentInfo?.agent_id;
                    const targetAgent = agent_id
                        ? process.agent.agent_id === agent_id
                            ? process.agent
                            : process.agent.workers?.get(agent_id)
                        : process.agent;

                    if (targetAgent && data) {
                        if (eventType === 'screenshot') {
                            // Use our helper to merge the screenshot with downsampling
                            mergeScreenshot(targetAgent, streamingEvent);
                        } else if (eventType === 'console') {
                            // Use our helper to merge the console data
                            mergeConsoleEvent(targetAgent, streamingEvent);
                        } else if (eventType === 'design') {
                            mergeDesignEvent(
                                targetAgent,
                                streamingEvent as DesignEvent
                            );
                        }
                        // Make sure parent references are updated properly
                        if (process.agent.agent_id === targetAgent.agent_id) {
                            // Agent already updated in place
                        } else if (process.agent.workers) {
                            // Update the worker reference in the parent
                            const updatedWorkers = new Map(
                                process.agent.workers
                            );
                            updatedWorkers.set(
                                targetAgent.agent_id!,
                                targetAgent
                            );
                            process.agent = {
                                ...process.agent,
                                workers: updatedWorkers,
                            };
                        }
                    } else if (agent_id && data) {
                        // Queue the screenshot for later when the agent becomes available
                        queuePending(
                            eventType === 'screenshot'
                                ? process.pendingScreenshots
                                : eventType === 'console'
                                  ? process.pendingConsoleEvents
                                  : process.pendingDesignEvents,
                            agent_id,
                            streamingEvent
                        );
                    }
                } else if (eventType === 'error') {
                    // Error message
                    const errorMessage =
                        'error' in streamingEvent
                            ? streamingEvent.error
                            : 'An error occurred';
                    addPartialMessage({
                        type: 'error',
                        content: errorMessage,
                    });
                } else if (
                    eventType === 'agent_start' ||
                    eventType === 'agent_updated'
                ) {
                    // Agent-related events for managing sub-agents and agent properties

                    // Check for parent-child relationship
                    if (
                        streamingEvent.agent &&
                        streamingEvent.agent.parent_id
                    ) {
                        // Generate a unique ID for the sub-agent
                        const workerId = streamingEvent.agent.agent_id;

                        // Add the sub-agent to the parent process's workers map if it doesn't exist yet
                        if (!process.agent!.workers.has(workerId)) {
                            // Create a new sub-agent data object
                            const worker: AgentData = {
                                agent_id: workerId,
                                parent: process.agent,
                                name: streamingEvent.agent.name || workerId,
                                messages: [
                                    completeMessage({
                                        content:
                                            streamingEvent.input ||
                                            `Worker for ${process.agent!.name || process.id}`,
                                    }),
                                ],
                                isTyping: true,
                                workers: new Map<string, AgentData>(),
                                model: streamingEvent.agent.model || undefined,
                                modelClass:
                                    streamingEvent.agent.modelClass ||
                                    undefined,
                            };

                            // Add this sub-agent to the parent's subAgents map
                            process.agent!.workers.set(workerId, worker);

                            // Flush any pending data for this newly created agent
                            flushPending(workerId);
                        } else if (streamingEvent.input) {
                            addPartialMessage({
                                content: streamingEvent.input,
                            });
                        }
                    } else if (streamingEvent.agent) {
                        const agent_id = streamingEvent.agent.agent_id;

                        // Check if this is the first time we're getting the agent_id
                        const isNewAgentId =
                            !process.agent!.agent_id ||
                            process.agent!.agent_id != agent_id;

                        if (isNewAgentId) {
                            process.agent!.agent_id = agent_id;
                        }

                        updateAgent({
                            name: streamingEvent.agent.name,
                            model: streamingEvent.agent.model || undefined,
                            modelClass:
                                streamingEvent.agent.modelClass || undefined,
                        });

                        // If this is the first time we've seen this agent, flush any pending data
                        if (isNewAgentId && agent_id) {
                            flushPending(agent_id);
                        }
                    }
                }

                // Turn off typing indicator for any response
                if (
                    eventType === 'message_complete' ||
                    eventType === 'tool_done'
                ) {
                    updateAgent({ isTyping: false });
                } else if (eventType === 'agent_status') {
                    updateAgent(
                        { statusEvent: streamingEvent },
                        streamingEvent.agent_id
                    );
                }

                // Default update: If the event wasn't handled above or didn't need a specific update,
                // ensure the process is still set in the new map (might be redundant in some cases, but safe).
                // This covers cases where an event type doesn't modify the process state directly here.
                if (!newProcesses.has(event.id)) {
                    newProcesses.set(event.id, { ...process });
                }

                return newProcesses; // Return the potentially modified map
            });
        });

        socketInstance.on('process:update', (event: ProcessUpdateEvent) => {
            setProcesses(prevProcesses => {
                const newProcesses = new Map(prevProcesses);
                const process = newProcesses.get(event.id) as
                    | ProcessData
                    | undefined;

                console.log(`${event.id} Received process:update`, event);

                if (process) {
                    // Update the status
                    newProcesses.set(event.id, {
                        ...process,
                        status: event.status,
                    });

                    // If process is terminated, handle sub-agents and remove after delay
                    if (
                        event.status === 'terminated' ||
                        event.status === 'completed'
                    ) {
                        // If this was the core process, we should find a new one
                        if (event.id === coreProcessId) {
                            // Find the first non-terminated process to be the new core
                            const remainingProcesses = Array.from(
                                newProcesses.entries()
                            ).filter(
                                ([id, p]) =>
                                    id !== event.id &&
                                    (p as ProcessData).status !==
                                        'terminated' &&
                                    (p as ProcessData).status !== 'completed'
                            );

                            if (remainingProcesses.length > 0) {
                                const newCoreId = remainingProcesses[0][0];
                                console.log(
                                    `Core process ${coreProcessId} terminated, setting new core to ${newCoreId}`
                                );
                                setCoreProcessId(newCoreId);
                            } else {
                                console.log(
                                    `Core process ${coreProcessId} terminated, no remaining processes`
                                );
                                setCoreProcessId(null);
                            }
                        }

                        // Remove the process after animation delay
                        setTimeout(() => {
                            setProcesses(prevProcesses => {
                                const updatedProcesses = new Map(prevProcesses);
                                updatedProcesses.delete(event.id);

                                return updatedProcesses;
                            });
                        }, 1200); // Same delay as in ProcessUI
                    }
                }

                return newProcesses;
            });
        });

        socketInstance.on('connect', () => {
            // Wait a bit to make sure we've received any existing processes
        });

        // Clean up on unmount
        return () => {
            // Disconnect the socket
            socketInstance.disconnect();
        };
    }, [serverVersion, coreProcessId]);

    // Define command functions
    const runCommand = (command: string) => {
        if (socket && command.trim()) {
            socket.emit('command:run', String(command));
        }
    };

    const sendProcessCommand = (processId: string, command: string) => {
        if (socket && command.trim()) {
            // Add the command as a user message immediately
            setProcesses(prevProcesses => {
                const newProcesses = new Map(prevProcesses);
                const process = newProcesses.get(processId) as
                    | ProcessData
                    | undefined;

                if (process) {
                    const userMessage: ClientMessage = {
                        id: generateId(),
                        processId: processId,
                        type: 'user',
                        content: command,
                        timestamp: new Date().toISOString(),
                    };
                    process.agent!.messages.push(userMessage);

                    newProcesses.set(processId, {
                        ...process,
                    });
                }

                return newProcesses;
            });

            // Send the command to the server
            socket.emit('process:command', {
                processId,
                command: String(command),
            } as ProcessCommandEvent);
        }
    };

    // Function to send a command always to the core process
    const sendCoreCommand = (command: string) => {
        if (coreProcessId) {
            sendProcessCommand(coreProcessId, command);
        } else if (processes.size > 0) {
            // Find the first active process if core isn't set
            const firstProcessId = Array.from(processes.keys())[0];
            sendProcessCommand(String(firstProcessId), command);
            // Also update the core process ID
            setCoreProcessId(String(firstProcessId));
        } else {
            // If no processes, create a new one
            runCommand(command);
        }
    };

    // Helper function to generate unique IDs
    const generateId = (): string => {
        return (
            Math.random().toString(36).substring(2, 15) +
            Math.random().toString(36).substring(2, 15)
        );
    };

    const terminateProcess = (processId: string) => {
        if (socket) {
            socket.emit('process:terminate', String(processId));
        }
    };

    // Toggle the pause state and notify the server
    const togglePauseState = () => {
        if (socket) {
            const newPauseState = !isPaused;
            setIsPaused(newPauseState);
            socket.emit('set_pause_state', newPauseState);
        }
    };

    // Toggle uimode and notify the server
    const toggleUIMode = () => {
        if (socket) {
            const newState = uiMode === 'canvas' ? 'column' : 'canvas';
            setUiMode(newState);
            socket.emit('uimode_state_update', newState);
        }
    };

    // Toggle audio state and notify the server
    const toggleAudioState = () => {
        if (socket) {
            const newState = !isAudioEnabled;
            if (!newState) {
                stopAudio();
            }
            setIsAudioEnabled(newState);
            socket.emit('set_audio_state', newState);
        }
    };

    // Toggle telegram state and notify the server
    const toggleTelegramState = () => {
        if (socket) {
            const newState = !isTelegramEnabled;
            setIsTelegramEnabled(newState);
            socket.emit('set_telegram_state', newState);
        }
    };

    // Provide context value
    const contextValue: SocketContextInterface = {
        socket,
        runCommand,
        sendProcessCommand,
        sendCoreCommand,
        terminateProcess,
        processes,
        serverVersion,
        coreProcessId,
        systemStatus,
        costData,
        isPaused,
        togglePauseState,
        uiMode,
        toggleUIMode,
        isAudioEnabled,
        toggleAudioState,
        isTelegramEnabled,
        toggleTelegramState,
    };

    return (
        <SocketContext.Provider value={contextValue}>
            {children}
        </SocketContext.Provider>
    );
};

// Create a custom hook for using the socket context
export const useSocket = () => useContext(SocketContext);
