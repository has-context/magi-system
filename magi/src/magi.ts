/**
 * Main entry point for the MAGI system (TypeScript version).
 *
 * This module handles command processing, agent initialization, and system setup.
 */

import 'dotenv/config';
import {parseArgs} from 'node:util';
import {Runner} from './utils/runner.js';
import {StreamingEvent} from './types.js';
import {createAgent, AgentType} from './magi_agents/index.js';
import {addHistory, getHistory} from './utils/history.js';
import {initCommunication, CommandMessage} from './utils/communication.js';

// Parse command line arguments
function parseCommandLineArgs() {
    const options = {
        test: {type: 'boolean' as const, short: 't', default: false},
        debug: {type: 'boolean' as const, short: 'd', default: false},
        agent: {type: 'string' as const, short: 'a', default: 'supervisor'},
        prompt: {type: 'string' as const, short: 'p'},
        base64: {type: 'string' as const, short: 'b'},
        model: {type: 'string' as const, short: 'm'},
        'model-class': {type: 'string' as const, short: 'c'},
    };

    const {values} = parseArgs({options, allowPositionals: true});
    return values;
}


/**
 * Execute a command using an agent and capture the results
 */
export async function runMagiCommand(
    command: string,
    agentType: AgentType = 'supervisor',
    model?: string,
    isTestMode: boolean = false,
    modelClass?: string
): Promise<void> {
    // Record command in system memory for context
    addHistory({
        role: 'user',
        content: command,
    });

    try {
        // Initialize communication system with process ID from env
        const processId = process.env.PROCESS_ID || `magi-${Date.now()}`;
        const comm = initCommunication(processId, isTestMode);
        comm.send({
            type: 'command_start',
            command
        });

        // Special debug handling for browser agent with direct execution
        if (agentType === 'browser' && command.toLowerCase().includes('yahoo')) {
            console.log('================================================================');
            console.log('DIRECT BROWSER AGENT HANDLING SHOULD TRIGGER FOR YAHOO REQUEST');
            console.log('================================================================');
        }

        // Create the agent with specified type, model, and modelClass
        if (model) {
            console.log(`Forcing model: ${model}`);
        }
        if (modelClass) {
            console.log(`Using model class: ${modelClass}`);
        }

        // Create the agent with model and modelClass parameters
        const agent = createAgent(agentType, model, modelClass);

        // Get conversation history
        const history = getHistory();

        // Set up event handlers
        const handlers = {
            // Forward all events to the communication channel
            onEvent: (event: StreamingEvent) => {
                comm.send(event);
            },

            // Handle message content updates
            onResponse: () => {
                // Nothing specific to do here as events are already being forwarded
            },

            // Handle completion of the entire command
            onComplete: () => {
                comm.send({ type: 'command_done', command });
            }
        };

        // Run the command with unified tool handling
        const response = await Runner.runStreamedWithTools(agent, command, history, handlers);

        // Add the final response to history
        if (response && response.trim()) {
            addHistory({
                type: 'message',
                role: 'assistant',
                content: response,
                status: 'completed'
            });
        }
    } catch (error: any) {
        // Handle any error that occurred during agent execution
        console.error(`Error running agent command: ${error?.message || String(error)}`);

        // Send error through WebSocket
        try {
            const processId = process.env.PROCESS_ID || `magi-${Date.now()}`;
            const comm = initCommunication(processId);
            comm.send({ type: 'error', error });
        } catch (commError) {
            console.error('Failed to send error via WebSocket:', commError);
        }
    }
}

/**
 * Process a command synchronously
 */
export function processCommand(
    command: string,
    agentType: AgentType = 'supervisor',
    model?: string,
    isTestMode: boolean = false,
    modelClass?: string
): Promise<void> {
    // Run the command
    return runMagiCommand(command, agentType, model, isTestMode, modelClass);
}

/**
 * Check environment variables for model provider API keys
 */
function checkModelProviderApiKeys(): boolean {
    let hasValidKey = false;

    // Check OpenAI API key
    if (process.env.OPENAI_API_KEY) {
        hasValidKey = true;
    } else {
        console.warn('⚠ OPENAI_API_KEY environment variable not set');
    }

    // Check Anthropic (Claude) API key
    if (process.env.ANTHROPIC_API_KEY) {
        hasValidKey = true;
    }

    // Check Google API key for Gemini
    if (process.env.GOOGLE_API_KEY) {
        hasValidKey = true;
    }

    // Check X.AI API key for Grok
    if (process.env.XAI_API_KEY) {
        hasValidKey = true;
    }

    return hasValidKey;
}

/**
 * Main function - entry point for the application
 */
async function main() {
    // Parse command line arguments
    const args = parseCommandLineArgs();

    // Set up process ID from env var
    const processId = process.env.PROCESS_ID || `magi-${Date.now()}`;
    console.log(`Initializing with process ID: ${processId}`);

    // Set up WebSocket communication (pass test flag from args)
    const comm = initCommunication(processId, args.test);

    // Set up command listener
    comm.onCommand((cmd: CommandMessage) => {
        console.log(`Received command via WebSocket: ${cmd.command}`);
        if (cmd.command === 'stop') {
            console.log('Received stop command, terminating...');
            process.exit(0);
        }
    });

    // Verify API keys for model providers
    if (!checkModelProviderApiKeys()) {
        console.error('**Error** No valid API keys found for any model provider');

        // Send error via WebSocket
        comm.send({ type: 'error', error: 'No valid API keys found for any model provider' });
        process.exit(1);
    }

    // Process prompt (either plain text or base64-encoded)
    let promptText: string;

    if (args.base64) {
        try {
            const buffer = Buffer.from(args.base64, 'base64');
            promptText = buffer.toString('utf-8');
        } catch (error) {
            console.error(`**Error** Failed to decode base64 prompt: ${error}`);
            process.exit(1);
        }
    } else if (args.prompt) {
        promptText = args.prompt;
    } else {
        console.error('**Error** Either --prompt or --base64 must be provided');
        process.exit(1);
    }

    // Run the command
    try {
        await processCommand(
            promptText,
            args.agent as AgentType,
            args.model,
            args.test === true,
            args['model-class']
        );

        // When running in test mode, exit after completion
        if (args.test) {
            console.log('\nTesting complete. Exiting.');
            process.exit(0);
        }
    } catch (error) {
        console.error(`**Error** Failed to process command: ${error}`);
        process.exit(1);
    }
}

main();
