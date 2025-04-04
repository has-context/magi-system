/**
 * Server Manager Module
 *
 * Handles server initialization, routing and WebSocket connections
 */
import express from 'express';
import Docker from 'dockerode';
import http from 'http';
import {Server as SocketIOServer, Socket} from 'socket.io';
import path from 'path';
import WebSocket from 'ws';
import {exec} from 'child_process';
import {ProcessCommandEvent, ServerInfoEvent} from '@types';
import {
	getServerVersion,
	loadAllEnvVars,
	saveEnvVar,
	updateServerVersion
} from './env_store';
import {ProcessManager} from './process_manager';
import {execPromise} from '../utils/docker_commands';
import {cleanupAllContainers} from './container_manager';
import {saveUsedColors} from './color_manager';
import {CommunicationManager} from './communication_manager';
import {setCommunicationManager} from '../utils/talk';
import {initTelegramBot, closeTelegramBot} from '../utils/telegram_bot';

const docker = new Docker();

export class ServerManager {
	private app = express();
	private server = http.createServer(this.app);
	private io = new SocketIOServer(this.server);
	private wss = new WebSocket.Server({noServer: true});
	private liveReloadClients = new Set<WebSocket>();
	private processManager: ProcessManager;
	private communicationManager: CommunicationManager;
	private cleanupInProgress = false;

	constructor() {
		this.processManager = new ProcessManager(this.io);

		// Initialize the communication manager before setting up WebSockets
		this.communicationManager = new CommunicationManager(this.server, this.processManager);

		// Initialize the talk module with the communication manager
		setCommunicationManager(this.communicationManager);

		// Initialize the Telegram bot
		initTelegramBot(this.communicationManager, this.processManager).catch(error => {
			console.error('Failed to initialize Telegram bot:', error);
		});

		this.setupWebSockets();
		this.setupSignalHandlers();
	}

	/**
	 * Set up the Express server
	 */
	private async setupServer(): Promise<void> {
		// Set up Docker volume access for magi_output
		await this.setupDockerVolumeAccess();

		// 2. Serve compiled JavaScript files from dist/src
		this.app.use('/client.js', (req, res) => {
			res.setHeader('Content-Type', 'application/javascript');
			res.sendFile(path.join(__dirname, '../../client.js'));
		});

		// 3. Serve static files from the dist folder
		this.app.use(express.static(path.join(__dirname, '../..')));

		// 4. Ensure the root route returns the index.html
		this.app.get('/', (req, res) => {
			res.sendFile(path.join(__dirname, '../../client/html/index.html'));
		});
	}

	/**
	 * Set up Docker volume file access for magi_output
	 * This creates a persistent helper container to access the volume
	 */
	private async setupDockerVolumeAccess(): Promise<void> {
		const HELPER_CONTAINER_NAME = 'magi-file-server';
		const fileCache = new Map<string, boolean>();

		// Define helper functions at the root level of setupDockerVolumeAccess
		const serveFileFromDocker = async (req: express.Request, res: express.Response): Promise<void> => {
			try {
				const filePath = req.path || '';
				const cleanPath = filePath.replace(/^\/+/, '');

				if (cleanPath.includes('..')) {
					res.status(403).send('Access denied');
					return;
				}

				// Check cache first
				if (!fileCache.has(cleanPath)) {
					// File not in cache, attempt to serve it
					const container = docker.getContainer(HELPER_CONTAINER_NAME);
					const fileServed = await getAndServeFile(container, cleanPath, res);

					if (fileServed) {
						fileCache.set(cleanPath, true);
					}
					return; // Response has already been sent
				}

				// File is in cache, serve it directly
				const container = docker.getContainer(HELPER_CONTAINER_NAME);
				await getAndServeFile(container, cleanPath, res);

			} catch (error) {
				console.error('Error serving file from Docker volume:', error);
				if (!res.headersSent) {
					res.status(500).send('Error accessing file');
				}
			}
		};

		// Set appropriate content type header based on file extension
		const setContentTypeHeader = (res: express.Response, filePath: string): void => {
			const extensionToContentType: Record<string, string> = {
				'.png': 'image/png',
				'.jpg': 'image/jpeg',
				'.jpeg': 'image/jpeg',
				'.gif': 'image/gif',
				'.svg': 'image/svg+xml',
				'.pdf': 'application/pdf',
				'.json': 'application/json',
				'.txt': 'text/plain'
			};

			const extension = Object.keys(extensionToContentType)
				.find(ext => filePath.endsWith(ext));

			if (extension) {
				res.setHeader('Content-Type', extensionToContentType[extension]);
			}
		};

		// Get and serve file content in one operation
		const getAndServeFile = async (container: Docker.Container, cleanPath: string, res: express.Response): Promise<boolean> => {
			const exec = await container.exec({
				Cmd: ['cat', `/magi_output/${cleanPath}`],
				AttachStdout: true,
				AttachStderr: true
			});

			const stream = await exec.start({});

			return new Promise<boolean>((resolve) => {
				const chunks: Buffer[] = [];

				stream.on('data', (chunk: Buffer) => chunks.push(chunk));

				stream.on('error', (err: Error) => {
					console.error('Stream error:', err);
					if (!res.headersSent) {
						res.status(500).send('Error reading file');
					}
					resolve(false);
				});

				stream.on('end', async () => {
					try {
						const buffer = Buffer.concat(chunks);
						if (buffer.length <= 8) {
							if (!res.headersSent) {
								res.status(404).send('File not found or empty');
							}
							resolve(false);
							return;
						}

						// Check if there was an error (indicating file not found)
						const inspect = await exec.inspect();
						if (inspect.ExitCode !== 0) {
							if (!res.headersSent) {
								res.status(404).send('File not found');
							}
							resolve(false);
							return;
						}

						const fileContent = extractDockerStreamContent(buffer);

						// Only set content type header when we know we're serving the file
						setContentTypeHeader(res, cleanPath);

						res.send(fileContent);
						resolve(true);
					} catch (err) {
						console.error('Error processing file content:', err);
						if (!res.headersSent) {
							res.status(500).send('Error processing file');
						}
						resolve(false);
					}
				});
			});
		};

		// Extract actual content from Docker stream (skipping frame headers)
		const extractDockerStreamContent = (buffer: Buffer): Buffer => {
			let fileContent = Buffer.alloc(0);
			let offset = 0;

			while (offset < buffer.length) {
				// Skip the 8-byte header
				const payloadSize = buffer.readUInt32BE(offset + 4);
				if (offset + 8 + payloadSize <= buffer.length) {
					const payload = buffer.slice(offset + 8, offset + 8 + payloadSize);
					fileContent = Buffer.concat([fileContent, payload]);
				}
				offset += 8 + payloadSize;
			}

			return fileContent;
		};

		try {
			// Check if container already exists
			const containers = await docker.listContainers({
				all: true,
				filters: { name: [HELPER_CONTAINER_NAME] }
			});

			if (containers.length > 0) {
				const container = docker.getContainer(HELPER_CONTAINER_NAME);
				const info = await container.inspect();

				// Start if not running
				if (!info.State.Running) {
					await container.start();
				}
			} else {
				// Create a new lightweight container that stays running
				await docker.createContainer({
					Image: 'alpine',
					name: HELPER_CONTAINER_NAME,
					Cmd: ['tail', '-f', '/dev/null'], // Keep container running
					Tty: true,
					Volumes: { '/magi_output': {} },
					HostConfig: {
						Binds: ['magi_output:/magi_output'],
						AutoRemove: false
					}
				}).then(container => container.start());
			}

			// Set up middleware for serving files from Docker volume
			this.app.use('/magi_output', (req, res, next) => {
				serveFileFromDocker(req, res).catch(next);
			});

		} catch (error) {
			console.error('Failed to set up Docker volume access:', error);
			// Fall back to direct mount approach if Docker API fails
			this.app.use('/magi_output', express.static('/magi_output', {
				setHeaders: (res, filePath) => {
					// Set appropriate content type for images
					if (filePath.endsWith('.png')) {
						res.setHeader('Content-Type', 'image/png');
					} else if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) {
						res.setHeader('Content-Type', 'image/jpeg');
					} else if (filePath.endsWith('.gif')) {
						res.setHeader('Content-Type', 'image/gif');
					} else if (filePath.endsWith('.svg')) {
						res.setHeader('Content-Type', 'image/svg+xml');
					}
				}
			}));
		}
	}

	/**
	 * Set up WebSocket handlers for Socket.io and live reload
	 */
	private setupWebSockets(): void {
		// Set up WebSocket server for live reload
		this.wss.on('connection', (ws) => {
			this.liveReloadClients.add(ws);

			ws.on('close', () => {
				this.liveReloadClients.delete(ws);
			});
		});

		// Handle upgrade for the WebSocket connection
		this.server.on('upgrade', (request, socket, head) => {
			const pathname = new URL(request.url || '', `http://${request.headers.host}`).pathname;

			if (pathname === '/livereload') {
				this.wss.handleUpgrade(request, socket, head, (ws) => {
					this.wss.emit('connection', ws, request);
				});
			} else if (pathname.startsWith('/ws/magi/')) {
				// Pass the upgrade request to the CommunicationManager's WebSocket server
				this.communicationManager.handleWebSocketUpgrade(request, socket, head);
			} else {
				socket.destroy();
			}
		});

		// Set up Socket.io connection handlers
		this.io.on('connection', this.handleSocketConnection.bind(this));
	}

	/**
	 * Set up Express routes
	 */
	private setupRoutes(): void {
		// Set up API route for LLM logs list
		this.app.get('/api/llm-logs/:processId', (req, res) => {
			try {
				const processId = req.params.processId;
				const containerName = `magi-${processId}`;

				// Get Docker logs
				exec(`docker exec ${containerName} node -e "const fs = require('fs'); const path = require('path'); const dir = '/magi_output/${processId}/logs/llm'; if (fs.existsSync(dir)) { const logs = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort(); console.log(JSON.stringify(logs)); } else { console.log('[]'); }"`, (err, stdout) => {
					if (err) {
						console.error(`Error getting LLM logs for ${processId}:`, err);
						res.status(500).json({ error: 'Error retrieving logs', details: String(err) });
						return;
					}

					// Parse the list of log files
					let logFiles;
					try {
						logFiles = JSON.parse(stdout.trim());
					} catch (parseErr) {
						console.error('Error parsing log files list:', parseErr);
						res.status(500).json({ error: 'Error parsing log files', details: String(parseErr) });
						return;
					}

					res.json({
						processId,
						logFiles
					});
				});
			} catch (error) {
				console.error('Error handling LLM logs request:', error);
				res.status(500).json({ error: 'Server error', details: String(error) });
			}
		});

		// Set up API route to get a specific log file
		this.app.get('/api/llm-logs/:processId/:logFile', (req, res) => {
			try {
				const processId = req.params.processId;
				const logFile = req.params.logFile;
				const containerName = `magi-${processId}`;

				// Validate log file name to prevent injection
				if (!logFile.match(/^[\w-]+\.json$/)) {
					res.status(400).json({ error: 'Invalid log file name' });
					return;
				}

				// Get log file content from Docker container
				exec(`docker exec ${containerName} cat /magi_output/${processId}/logs/llm/${logFile}`, (err, stdout) => {
					if (err) {
						console.error(`Error getting log file ${logFile} for ${processId}:`, err);
						res.status(500).json({ error: 'Error retrieving log file', details: String(err) });
						return;
					}

					// Parse the log file content as JSON
					let logContent;
					try {
						logContent = JSON.parse(stdout.trim());
						res.json(logContent);
					} catch (parseErr) {
						console.error('Error parsing log file content:', parseErr);
						res.status(500).json({ error: 'Error parsing log file content', details: String(parseErr) });
					}
				});
			} catch (error) {
				console.error('Error handling log file request:', error);
				res.status(500).json({ error: 'Server error', details: String(error) });
			}
		});

		// Set up API route to get cost tracking data
		this.app.get('/api/cost-tracker/:processId', (req, res) => {
			try {
				const processId = req.params.processId;
				const containerName = `magi-${processId}`;

				// Get cost tracker data from Docker container
				exec(`docker exec ${containerName} node -e "const { costTracker } = require('./dist/utils/cost_tracker.js'); console.log(JSON.stringify({ total: costTracker.getTotalCost(), byModel: costTracker.getCostsByModel() }))"`, (err, stdout) => {
					if (err) {
						console.error(`Error getting cost tracker data for ${processId}:`, err);
						res.status(500).json({ error: 'Error retrieving cost data', details: String(err) });
						return;
					}

					// Parse the cost tracker data
					let costData;
					try {
						costData = JSON.parse(stdout.trim());
						res.json(costData);
					} catch (parseErr) {
						console.error('Error parsing cost tracker data:', parseErr);
						res.status(500).json({ error: 'Error parsing cost tracker data', details: String(parseErr) });
					}
				});
			} catch (error) {
				console.error('Error handling cost tracker request:', error);
				res.status(500).json({ error: 'Server error', details: String(error) });
			}
		});

		// Set up API route to get Docker container logs
		this.app.get('/api/docker-logs/:processId', (req, res) => {
			try {
				const processId = req.params.processId;
				const containerName = `magi-${processId}`;
				const lines = req.query.lines ? parseInt(req.query.lines as string) : 1000;

				// Get Docker container logs
				exec(`docker logs --tail=${lines} ${containerName}`, (err, stdout) => {
					if (err) {
						console.error(`Error getting Docker logs for ${processId}:`, err);
						res.status(500).json({ error: 'Error retrieving Docker logs', details: String(err) });
						return;
					}

					res.json({
						processId,
						logs: stdout.split('\n')
					});
				});
			} catch (error) {
				console.error('Error handling Docker logs request:', error);
				res.status(500).json({ error: 'Server error', details: String(error) });
			}
		});

		// Exclude /magi_output and /api paths from the catch-all route
		this.app.get('*', (req, res, next) => {
			// Check if the request path starts with /magi_output or /api
			if (req.path.startsWith('/magi_output/') || req.path.startsWith('/api/')) {
				// Skip to the next middleware
				return next();
			}

			// For all other routes, serve the index.html for client-side routing
			res.sendFile(path.join(__dirname, '../../client/html/index.html'));
		});
	}

	/**
	 * Set up signal handlers for graceful shutdown
	 */
	private setupSignalHandlers(): void {
		// Register cleanup handlers for various termination signals
		process.on('SIGINT', this.handleTerminationSignal.bind(this));
		process.on('SIGTERM', this.handleTerminationSignal.bind(this));

		// Also handle uncaught exceptions and unhandled promise rejections
		process.on('uncaughtException', (err) => {
			console.error('Uncaught exception:', err);
			this.handleTerminationSignal().catch(error => {
				console.error('Error during cleanup after uncaught exception:', error);
				process.exit(1);
			});
		});

		process.on('unhandledRejection', (reason) => {
			console.error('Unhandled promise rejection:', reason);
			// Don't exit the process, just log the error
		});

		// Handle nodemon restarts by cleaning up containers
		if (process.env.NODE_ENV === 'development') {
			process.on('SIGUSR2', async () => {
				console.log('Received SIGUSR2 (nodemon restart)');

				if (typeof closeTelegramBot === 'function') {
					try {
						console.log('Closing Telegram bot before nodemon restart...');
						closeTelegramBot().catch(e => console.error('Error during Telegram shutdown:', e));
					} catch (error) {
						console.error('Error closing Telegram bot during nodemon restart:', error);
					}
				}
				// Don't do a full cleanup since we're just restarting
				// But make sure containers keep running
			});
		}
	}

	/**
	 * Handle Socket.io connection
	 *
	 * @param socket - The connected socket
	 */
	private handleSocketConnection(socket: Socket): void {
		const clientId = socket.id.substring(0, 8);
		console.log(`Client connected: ${clientId}`);

		// Send server info to the client
		socket.emit('server:info', {
			version: getServerVersion()
		} as ServerInfoEvent);

		// Clean up terminated processes
		this.processManager.cleanupTerminatedProcesses();

		// Send current processes to the new client (excluding terminated)
		const processes = this.processManager.getAllProcesses();
		Object.entries(processes).forEach(([id, process]) => {
			console.log(`Sending process ${id} state to new client ${clientId}`);

			// First send the process creation event
			socket.emit('process:create', {
				id,
				command: process.command,
				status: process.status,
				colors: process.colors
			});

			// Then send all accumulated logs
			if (process.logs.length > 0) {
				socket.emit('process:logs', {
					id,
					logs: process.logs.join('\n')
				});
			}
		});

		// Handle command:run event
		socket.on('command:run', (command: string) => {
			const clientId = socket.id.substring(0, 8);
			console.log(`Client ${clientId} sent command:run event: "${command}"`);
			this.handleCommandRun(command);
		});

		// Handle process:terminate event
		socket.on('process:terminate', async (processId: string) => {
			console.log(`Client ${clientId} requested termination of process ${processId}`);
			await this.handleProcessTerminate(socket, processId);
		});

		// Handle process:command event
		socket.on('process:command', async (data: ProcessCommandEvent) => {
			console.log(`Client ${clientId} sent command to process ${data.processId}: ${data.command}`);
			await this.handleProcessCommand(socket, data);
		});

		// Handle disconnect
		socket.on('disconnect', () => {
			console.log(`Client disconnected: ${clientId}`);
			// Note: We don't stop any processes when a client disconnects,
			// as other clients may still be monitoring them
		});
	}

	/**
	 * Handle command:run event
	 *
	 * @param command - The command to run
	 */
	async handleCommandRun(command: string): Promise<void> {
		// Validate command string
		if (!command || typeof command !== 'string' || !command.trim()) {
			console.error('Invalid command received:', command);
			return;
		}

		// Generate a unique process ID
		const processId = `AI-${Math.random().toString(36).substring(2, 8)}`;

		// Create a new process
		await this.processManager.createProcess(processId, command);
	}

	/**
	 * Handle process:terminate event
	 *
	 * @param socket - The socket that sent the event
	 * @param processId - The ID of the process to terminate
	 */
	private async handleProcessTerminate(socket: Socket, processId: string): Promise<void> {
		// Verify the process exists
		const process = this.processManager.getProcess(processId);
		if (!process) {
			console.warn(`Process ${processId} does not exist, can't terminate`);
			socket.emit('process:logs', {
				id: processId,
				logs: '[ERROR] Process does not exist or has already terminated'
			});
			return;
		}

		// First try to terminate using WebSocket if available
		if (this.communicationManager.hasActiveConnection(processId)) {
			// Try graceful shutdown via WebSocket first
			console.log(`Attempting graceful termination of ${processId} via WebSocket`);
			const wsSuccess = this.communicationManager.stopProcess(processId);

			if (wsSuccess) {
				console.log(`Process ${processId} gracefully terminating via WebSocket`);
				this.processManager.updateProcess(
					processId,
					'[INFO] Gracefully shutting down...'
				);

				// Give it a moment to shut down cleanly before forcing
				await new Promise(resolve => setTimeout(resolve, 2000));
			}
		}

		// Forcefully stop the container in case graceful shutdown fails or isn't available
		console.log(`Forcefully stopping container for process ${processId}`);
		const success = await this.processManager.stopProcess(processId);

		if (!success) {
			console.error(`Failed to terminate process ${processId}`);
			socket.emit('process:logs', {
				id: processId,
				logs: '[ERROR] Failed to terminate process'
			});
		}
	}

	/**
	 * Handle process:command event
	 *
	 * @param socket - The socket that sent the event
	 * @param data - The command data
	 */
	private async handleProcessCommand(socket: Socket, data: ProcessCommandEvent): Promise<void> {
		const {processId, command, sourceProcessId} = data;

		// Verify the process exists and is running
		const process = this.processManager.getProcess(processId);
		if (!process) {
			console.warn(`Cannot send command: Process ${processId} does not exist`);
			socket.emit('process:logs', {
				id: processId,
				logs: '[ERROR] Process does not exist or has terminated'
			});
			return;
		}

		if (process.status !== 'running') {
			console.warn(`Cannot send command: Process ${processId} is not running (status: ${process.status})`);
			socket.emit('process:logs', {
				id: processId,
				logs: `[ERROR] Cannot send command: process is not running (status: ${process.status})`
			});
			return;
		}

		// Try WebSocket communication first
		let success = false;
		if (this.communicationManager.hasActiveConnection(processId)) {
			success = this.communicationManager.sendCommand(
				processId,
				command,
				{},
				sourceProcessId
			);

			if (success) {
				console.log(`Command sent to process ${processId} successfully via WebSocket${sourceProcessId ? ` from process ${sourceProcessId}` : ''}`);
				this.processManager.updateProcess(
					processId,
					'[INFO] Command sent via WebSocket'
				);
				return;
			}
		}

		// Fallback to FIFO if WebSocket fails or isn't available
		console.log(`WebSocket communication failed or not available for ${processId}, falling back to FIFO`);

		// Import here to avoid circular dependency
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const {sendCommandToContainer} = require('./container_manager');

		// Process command in the container using the legacy method
		success = await sendCommandToContainer(processId, command);

		if (!success) {
			console.error(`Failed to send command to container for process ${processId}`);
			this.processManager.updateProcess(
				processId,
				'[ERROR] Failed to send command: Unable to communicate with container'
			);
		} else {
			console.log(`Command sent to process ${processId} successfully via FIFO`);
			// The command response will come through container logs
		}
	}

	/**
	 * Handle SIGINT or SIGTERM signal
	 */
	private async handleTerminationSignal(): Promise<void> {
		// Skip if cleanup is already in progress
		if (this.cleanupInProgress) {
			console.log('Cleanup already in progress, waiting...');
			return;
		}

		this.cleanupInProgress = true;
		console.log('Received termination signal - beginning graceful shutdown');

		// Set a maximum time for cleanup to prevent hanging
		const MAX_CLEANUP_TIME = 10000; // 10 seconds (increased for Docker)
		let cleanupTimedOut = false;

		const cleanupTimeout = setTimeout(() => {
			console.log('Cleanup taking too long, forcing exit...');
			cleanupTimedOut = true;
			// Force cleanup containers before exiting
			cleanupAllContainers().finally(() => {
				process.exit(0);
			});
		}, MAX_CLEANUP_TIME);

		try {
			await this.cleanup();
			// Cleanup completed normally, clear the timeout
			clearTimeout(cleanupTimeout);
			console.log('Cleanup completed successfully');
		} catch (error) {
			console.error('Error during cleanup:', error);
			// Make sure we still clear the timeout on error
			clearTimeout(cleanupTimeout);
		}

		// If we haven't timed out, exit with a short delay for final messages
		if (!cleanupTimedOut) {
			console.log('Shutting down gracefully...');
			setTimeout(() => {
				console.log('Goodbye!');
				process.exit(0);
			}, 500);
		}
	}

	/**
	 * Clean up resources before server shutdown
	 */
	private async cleanup(): Promise<void> {
		console.log('MAGI System shutting down - cleaning up resources...');

		// Step 0: Close Telegram bot connection
		try {
			console.log('Closing Telegram bot...');
			await closeTelegramBot();
		} catch (error) {
			console.error('Error closing Telegram bot:', error);
		}

		// Step 1: Try to gracefully stop all processes first by sending stop command
		// This gives them a chance to clean up properly
		try {
			const processIds = Object.keys(this.processManager.getAllProcesses());
			console.log(`Attempting to gracefully stop ${processIds.length} processes...`);

			// Send stop commands to all processes first
			await Promise.all(
				processIds.map(async (processId) => {
					try {
						console.log(`Sending stop command to process ${processId}...`);
						return this.communicationManager.stopProcess(processId);
					} catch (err) {
						console.error(`Error sending stop command to ${processId}:`, err);
						return false;
					}
				})
			);

			// Give processes a moment to handle the stop command
			console.log('Waiting for processes to handle stop commands...');
			await new Promise(resolve => setTimeout(resolve, 1000));
		} catch (error) {
			console.error('Error during graceful process stop phase:', error);
		}

		// Step 2: Close all WebSocket connections
		try {
			console.log('Closing all WebSocket connections...');
			this.communicationManager.closeAllConnections();
		} catch (error: unknown) {
			console.error('Error closing WebSocket connections:', error);
		}

		// Step 3: Force clean up all processes
		try {
			console.log('Force stopping all processes...');
			await this.processManager.cleanup();
		} catch (error: unknown) {
			console.error('Error during process cleanup:', error);
		}

		// Step 4: Additional cleanup for any containers that might have been missed
		try {
			console.log('Running final container cleanup...');
			await cleanupAllContainers();

			// Double-check AI process containers
			const {stdout: aiStdout} = await execPromise("docker ps --filter 'name=magi-AI' --format '{{.Names}}'");
			if (aiStdout.trim()) {
				console.log(`WARNING: Found ${aiStdout.trim().split('\n').length} AI containers still RUNNING: ${aiStdout}`);
				console.log('Forcing removal of all AI containers...');
				await execPromise("docker ps --filter 'name=magi-AI' -q | xargs -r docker rm -f");
			}

			// Also check for controller child containers (excluding file-server)
			const {stdout: childStdout} = await execPromise("docker ps --filter 'name=magi-' --format '{{.Names}}' | grep -v controller | grep -v file-server");
			if (childStdout.trim()) {
				console.log(`WARNING: Found ${childStdout.trim().split('\n').length} MAGI containers still RUNNING: ${childStdout}`);
				console.log('Forcing removal of all child containers...');
				await execPromise("docker ps --filter 'name=magi-' -q | grep -v controller | grep -v file-server | xargs -r docker rm -f");
			}

			// Final check - are there ANY magi containers left?
			const {stdout: finalStdout} = await execPromise("docker ps -a --filter 'name=magi-AI' --format '{{.Names}}'");
			if (finalStdout.trim()) {
				console.log(`FINAL WARNING: Still found containers after all cleanup attempts: ${finalStdout}`);
				console.log('Executing desperate final cleanup...');
				await execPromise("docker kill $(docker ps -q --filter 'name=magi-AI') 2>/dev/null || true");
				await execPromise("docker ps -a -q --filter 'name=magi-AI' | xargs -r docker rm -f");
			} else {
				console.log('All MAGI containers have been successfully stopped and removed');
			}
		} catch (error: unknown) {
			console.error('Error during final container cleanup:', error);
			// Even if we have an error, try one last command
			try {
				await execPromise("docker ps -a -q --filter 'name=magi-' | grep -v file-server | xargs -r docker rm -f 2>/dev/null || true");
			} catch (e) {
				// Ignore any errors in this last attempt
			}
		}

		// Step 5: Save used colors to persist across restarts
		try {
			saveUsedColors();
		} catch (error: unknown) {
			console.error('Error saving used colors:', error);
		}

		console.log('Cleanup completed');
	}

	/**
	 * Finds an available port for the server to listen on
	 *
	 * @param startPort - The port to start checking from
	 * @returns Promise resolving to an available port number
	 */
	private async findAvailablePort(startPort: number): Promise<number> {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const net = require('net');
		let port = startPort;
		const maxPort = startPort + 100; // Try up to 100 ports
		const maxAttempts = 100; // Safety limit
		let attempts = 0;

		while (port < maxPort && attempts < maxAttempts) {
			attempts++;
			try {
				// Try to bind to the port
				const available = await new Promise<boolean>((resolve) => {
					const server = net.createServer();

					server.once('error', (err: unknown) => {
						server.close();
						if (err && typeof err === 'object' && 'code' in err && err.code === 'EADDRINUSE') {
							console.log(`Port ${port} in use, trying next port`);
							resolve(false);
						} else {
							console.error(`Error checking port ${port}:`, err);
							resolve(false);
						}
					});

					server.once('listening', () => {
						server.close();
						resolve(true);
					});

					server.listen(port);
				});

				if (available && port !== startPort) {
					console.log(`Found available port: ${port}`);
					return port;
				}

				// Try next port
				port++;

			} catch (error: unknown) {
				console.error(`Unexpected error checking port ${port}:`, error);
				port++;
			}
		}

		// Fallback to a random port if no port found in the range
		const randomPort = 8000 + Math.floor(Math.random() * 1000);
		console.log(`Could not find available port in range ${startPort}-${maxPort}, using random port ${randomPort}`);
		return randomPort;
	}

	/**
	 * Start the server and handle container reconnection
	 */
	async start(): Promise<void> {
		// Load stored environment variables
		loadAllEnvVars();
		updateServerVersion();

		// Initialize the server asynchronously
		await this.setupServer();
		this.setupRoutes();

		// Get port from environment or use 3001
		const isNodemonRestart = process.env.HAS_RESTARTED === 'true';
		if (!isNodemonRestart) {
			saveEnvVar('HAS_RESTARTED', 'true');
		}
		const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3010;
		console.log(`Starting MAGI System Server (port: ${PORT}, restart: ${isNodemonRestart})`);

		// If this is a restart, retrieve running MAGI containers
		if (isNodemonRestart) {
			try {
				await this.processManager.retrieveExistingContainers();
			} catch (error) {
				console.error('Failed to retrieve existing containers:', error);
			}
		}

		try {
			// Only find an available port on first start, otherwise use the configured port
			const port = isNodemonRestart ? PORT : await this.findAvailablePort(PORT);
			if (port !== PORT) {
				saveEnvVar('PORT', port.toString());
				// Update the current process environment as well
				process.env.PORT = port.toString();
				console.log(`Port has changed to ${port}, updating environment`);
			}

			// Handle server errors
			this.server.on('error', (err: unknown) => {
				if (err && typeof err === 'object' && 'code' in err && err.code === 'EADDRINUSE') {
					console.error(`Port ${port} is in use despite port check. Trying a random port...`);
					const randomPort = 8000 + Math.floor(Math.random() * 1000);

					// Update the PORT in both storage and current process environment
					saveEnvVar('PORT', randomPort.toString());
					process.env.PORT = randomPort.toString();
					console.log(`Port has changed to ${randomPort}, updating environment`);

					this.server.listen(randomPort);
				} else {
					console.error('Server error:', err);
					process.exit(1);
				}
			});

			// Start the server
			this.server.listen(port, () => {
				const address = this.server.address();
				if (!address || typeof address === 'string') {
					console.error('Invalid server address');
					return;
				}

				const listeningPort = address.port;

				// Make sure our environment reflects the actual port used
				if (listeningPort.toString() !== process.env.PORT) {
					process.env.PORT = listeningPort.toString();
					saveEnvVar('PORT', listeningPort.toString());
					console.log(`Final port determined to be ${listeningPort}, updating environment`);

					// If this is a port change, make sure connections are handled properly
					if (isNodemonRestart) {
						console.log(`Port changed during restart. New containers will use port ${listeningPort}. Existing containers will update on reconnection.`);
					}
				}

				const url = `http://localhost:${listeningPort}`;

				console.log(`
┌────────────────────────────────────────────────┐
│                                                │
│  MAGI System Server is Running!                │
│                                                │
│  • Local:    ${url.padEnd(33)} │
│                                                │
└────────────────────────────────────────────────┘
        `);

			});
		} catch (error: unknown) {
			console.error('Failed to start server:', error);
			process.exit(1);
		}
	}
}
