/**
 * Communication Manager Module
 *
 * Handles WebSocket communication with MAGI containers
 */

import {Server as WebSocketServer, WebSocket} from 'ws';
import {Server as HttpServer} from 'http';
import {ProcessManager} from './process_manager';
import fs from 'fs';
import path from 'path';

// Event types for the server-client communication
export interface MagiMessage {
	processId: string;
	type?: string;
	data?: unknown;
	event?: {
		type: string;
		[key: string]: unknown;
	};
}

// Older format message types (maintained for backwards compatibility)
export interface ProgressMessage {
	type: 'progress';
	processId: string;
	data: {
		step: string;
		status: 'running' | 'completed' | 'failed';
		message: string;
		progress?: number;
	};
}

export interface ResultMessage {
	type: 'result';
	processId: string;
	data: unknown;
}

export interface CommandMessage {
	type: 'command' | 'connect';
	command: string;
	args?: any;
}

export interface ContainerConnection {
	processId: string;
	lastMessage: Date;
	messageHistory: MagiMessage[];
}

export class CommunicationManager {
	private wss: WebSocketServer;
	private processManager: ProcessManager;
	private connections: Map<string, WebSocket> = new Map();
	private containerData: Map<string, ContainerConnection> = new Map();
	private storageDir: string;

	constructor(server: HttpServer, processManager: ProcessManager) {
		this.processManager = processManager;
		this.storageDir = path.join(process.cwd(), 'dist/.server/magi_messages');

		// Ensure storage directory exists
		if (!fs.existsSync(this.storageDir)) {
			fs.mkdirSync(this.storageDir, {recursive: true});
		}

		// Initialize WebSocket server
		this.wss = new WebSocketServer({
			noServer: true
		});

		this.setupWebSocketServer();
		console.log('WebSocket server initialized for container communication');
	}

	/**
	 * Handle WebSocket upgrade requests
	 */
	public handleWebSocketUpgrade(request: any, socket: any, head: any): void {
		// Extract process ID from URL path
		// Expected format: /ws/magi/:processId
		const urlPath = request.url || '';
		const pathParts = urlPath.split('/');
		const processId = pathParts[pathParts.length - 1];

		if (!processId || processId === 'magi') {
			console.error('Invalid WebSocket upgrade attempt - missing process ID');
			socket.destroy();
			return;
		}

		// Handle the upgrade
		this.wss.handleUpgrade(request, socket, head, (ws) => {
			// Set the processId as a property on the WebSocket
			(ws as any).processId = processId;
			this.wss.emit('connection', ws, request);
		});
	}

	private setupWebSocketServer(): void {
		this.wss.on('connection', (ws) => {
			try {
				// Get the processId from the WebSocket object
				const processId = (ws as any).processId;

				if (!processId || processId === 'magi') {
					console.error('Invalid WebSocket connection attempt - missing process ID');
					ws.close(1008, 'Invalid connection - missing process ID');
					return;
				}

				console.log(`WebSocket connection established for process ${processId}`);

				// Store connection
				this.connections.set(processId, ws);

				// Initialize container data if not exists
				if (!this.containerData.has(processId)) {
					const containerConnection: ContainerConnection = {
						processId,
						lastMessage: new Date(),
						messageHistory: []
					};

					this.containerData.set(processId, containerConnection);

					// Load history from disk if available
					this.loadMessageHistory(processId);
				}

				// Handle incoming messages
				ws.on('message', (data) => {
					try {
						const message = JSON.parse(data.toString()) as MagiMessage;

						if (!message.processId || message.processId !== processId) {
							console.error(`Message process ID mismatch: ${message.processId} vs ${processId}`);
							return;
						}

						// Update last message timestamp
						const containerData = this.containerData.get(processId);
						if (containerData) {
							containerData.lastMessage = new Date();

							// Store in message history
							containerData.messageHistory.push(message);

							// Save to disk periodically (we don't need to save every message)
							if (containerData.messageHistory.length % 5 === 0) {
								this.saveMessageHistory(processId);
							}
						}

						// Process the message based on type
						this.processContainerMessage(processId, message);
					} catch (err) {
						console.error('Error processing WebSocket message:', err);
					}
				});

				// Handle disconnections
				ws.on('close', () => {
					console.log(`WebSocket connection closed for process ${processId}`);
					this.connections.delete(processId);

					// Save message history on disconnect but don't delete container data
					// This allows us to preserve history if the container reconnects
					this.saveMessageHistory(processId);

					// Log that the container may reconnect with updated port
					const serverPort = process.env.PORT || '3010';
					console.log(`Container ${processId} disconnected. When it reconnects, it will use port ${serverPort}`);
				});

				// Handle errors
				ws.on('error', (err) => {
					console.error(`WebSocket error for process ${processId}:`, err);
					this.connections.delete(processId);
				});

				// Send a welcome message to confirm connection
				// Include the current server port so containers can update if needed
				const serverPort = process.env.PORT || '3010';
				const connectMessage: CommandMessage = {
					type: 'connect',
					command: '',
					args: {
						timestamp: new Date().toISOString(),
						controllerPort: serverPort
					}
				};

				ws.send(JSON.stringify(connectMessage));
			} catch (err) {
				console.error('Error handling WebSocket connection:', err);
				ws.close(1011, 'Internal server error');
			}
		});
	}

	/**
	 * Process messages received from containers
	 */
	private processContainerMessage(processId: string, message: MagiMessage): void {
		try {
			// First, check if this is the new format with 'event' property
			if (message.event) {
				const eventType = message.event.type;
				
				// Process any content field to fix references to /magi_output paths
				// Helper function to process strings with magi_output paths
				const processOutputPaths = (text: string): string => {
					// Replace "sandbox:/magi_output/" with "/magi_output/" (sandbox prefix)
					let processed = text.replace(/sandbox:\/magi_output\//g, '/magi_output/');
					
					// Also handle other sandbox paths
					processed = processed.replace(/sandbox:(\/[^\s)"']+)/g, '$1');
					
					// Fix undefined links by replacing markdown link syntax with the text content only
					processed = processed.replace(/\[([^\]]+)\]\(undefined\)/g, '$1');
					
					// Fix links with [object Object] in the URL - get just the link text
					processed = processed.replace(/\[([^\]]+)\]\(\[object Object\]\)/g, '$1');
					
					// Fix undefined text with undefined URLs
					processed = processed.replace(/undefined\s*\(undefined\)/g, '');
					
					// Make sure URLs like /magi_output/... are correctly formatted as markdown links
					processed = processed.replace(
						/(\s|^)(\/magi_output\/[^\s)"']+\.(png|jpg|jpeg|gif|svg))(\s|$|[,.;])/gi, 
						(match, pre, url, ext, post) => `${pre}[${url}](${url})${post}`
					);
					
					return processed;
				};
				
				// Process content field
				if (message.event.content && typeof message.event.content === 'string') {
					message.event.content = processOutputPaths(message.event.content);
				}
				
				// Process tool results for image paths
				if (message.event.type === 'tool_done' && message.event.results && typeof message.event.results === 'object') {
					// Process each result to fix output paths in result strings
					const results = message.event.results as Record<string, any>;
					for (const resultId in results) {
						const result = results[resultId];
						
						// Fix paths in string results
						if (typeof result === 'string') {
							results[resultId] = processOutputPaths(result);
						}
						
						// Fix paths in object results with output property
						else if (typeof result === 'object' && result !== null && 'output' in result && typeof result.output === 'string') {
							result.output = processOutputPaths(result.output);
						}
					}
				}

				// Emit a dedicated event for structured messages directly to Socket.io clients
				this.processManager.io.emit('process:message', {
					id: processId,
					message: message
				});

				// Also log to Docker logs for debugging purposes only
				if(eventType !== 'message_delta') {
					console.log(`[${processId}] ${eventType}`);
					console.dir(message, {depth: 4, colors: true});
				}
				return;
			}

			// Fallback to older message format with direct 'type' property
			if (message.type) {
				// For backwards compatibility, also emit these as structured messages
				this.processManager.io.emit('process:message', {
					id: processId,
					message: message
				});

				// Log specific types for debugging
				switch (message.type) {
					case 'connection':
						console.log(`Container ${processId} connected`);
						break;

					case 'progress': {
						const progressMsg = message as ProgressMessage;
						console.log(`[${processId}] Progress: ${progressMsg.data.step} - ${progressMsg.data.message}`);
						break;
					}

					case 'result': {
						console.log(`Received final result from process ${processId}`);
						break;
					}
				}
				return;
			}

			// If we get here, the message doesn't have either format
			console.log(`Message with invalid format from process ${processId}: ${JSON.stringify(message)}`);

		} catch (error) {
			console.error(`Error processing message from ${processId}:`, error);
		}
	}

	/**
	 * Send a command to a specific container
	 */
	async sendCommand(processId: string, command: string, args?: any): Promise<boolean> {
		const connection = this.connections.get(processId);

		if (!connection) {
			console.error(`No active connection for process ${processId}`);
			return false;
		}

		try {
			const commandMessage: CommandMessage = {
				type: 'command',
				command,
				args
			};

			connection.send(JSON.stringify(commandMessage));
			return true;
		} catch (err) {
			console.error(`Error sending command to process ${processId}:`, err);
			return false;
		}
	}

	/**
	 * Save message history for a process to disk
	 */
	private saveMessageHistory(processId: string): void {
		const containerData = this.containerData.get(processId);

		if (!containerData) {
			return;
		}

		try {
			const filePath = path.join(this.storageDir, `${processId}_messages.json`);
			fs.writeFileSync(
				filePath,
				JSON.stringify(containerData.messageHistory, null, 2),
				'utf8'
			);
		} catch (err) {
			console.error(`Error saving message history for process ${processId}:`, err);
		}
	}

	/**
	 * Load message history for a process from disk
	 */
	private loadMessageHistory(processId: string): void {
		try {
			const filePath = path.join(this.storageDir, `${processId}_messages.json`);

			if (fs.existsSync(filePath)) {
				const data = fs.readFileSync(filePath, 'utf8');
				const messages = JSON.parse(data) as MagiMessage[];

				// Update container data
				const containerData = this.containerData.get(processId);
				if (containerData) {
					containerData.messageHistory = messages;
					console.log(`Loaded ${messages.length} historical messages for process ${processId}`);
				}
			}
		} catch (err) {
			console.error(`Error loading message history for process ${processId}:`, err);
		}
	}

	/**
	 * Get message history for a process
	 */
	getMessageHistory(processId: string): MagiMessage[] {
		const containerData = this.containerData.get(processId);

		if (!containerData) {
			return [];
		}

		return [...containerData.messageHistory];
	}

	/**
	 * Check if a process has an active connection
	 */
	hasActiveConnection(processId: string): boolean {
		return this.connections.has(processId);
	}

	/**
	 * Stop a process by sending a stop command
	 */
	async stopProcess(processId: string): Promise<boolean> {
		return this.sendCommand(processId, 'stop');
	}

	/**
	 * Close all connections
	 */
	closeAllConnections(): void {
		for (const [processId, connection] of this.connections.entries()) {
			try {
				connection.close();
				console.log(`Closed WebSocket connection for process ${processId}`);

				// Save message history
				this.saveMessageHistory(processId);
			} catch (err) {
				console.error(`Error closing WebSocket connection for process ${processId}:`, err);
			}
		}

		this.connections.clear();
	}
}