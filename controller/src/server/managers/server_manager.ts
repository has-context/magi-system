/**
 * Server Manager Module
 *
 * Handles server initialization, routing and WebSocket connections
 */
import express from 'express';
import http from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import path from 'path';
import WebSocket from 'ws';
import { exec } from 'child_process';
import { ProcessCommandEvent, ServerInfoEvent } from '@types';
import {
  getServerVersion,
  loadAllEnvVars,
  saveEnvVar,
  updateServerVersion
} from './env_store';
import { ProcessManager } from './process_manager';
import { cleanupAllContainers } from './container_manager';
import { saveUsedColors } from './color_manager';
import { CommunicationManager } from './communication_manager';

export class ServerManager {
  private app = express();
  private server = http.createServer(this.app);
  private io = new SocketIOServer(this.server);
  private wss = new WebSocket.Server({ noServer: true });
  private liveReloadClients = new Set<WebSocket>();
  private processManager: ProcessManager;
  private communicationManager: CommunicationManager;
  private cleanupInProgress = false;

  constructor() {
    this.processManager = new ProcessManager(this.io);
    this.setupServer();
    this.setupWebSockets();
    this.setupRoutes();
    this.setupSignalHandlers();
    
    // Initialize the communication manager after the server is set up
    this.communicationManager = new CommunicationManager(this.server, this.processManager);
  }

  /**
   * Set up the Express server
   */
  private setupServer(): void {
    // Serve compiled JavaScript files from dist/src
    this.app.use('/client.js', (req, res) => {
      res.setHeader('Content-Type', 'application/javascript');
      res.sendFile(path.join(__dirname, '../../client.js'));
    });

    // Serve static files from the dist folder
    this.app.use(express.static(path.join(__dirname, '../../client')));
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
        // We don't need to do anything here as the CommunicationManager
        // will handle these connections after it's initialized
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
    this.app.get('/', (req, res) => {
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
  private handleCommandRun(command: string): void {
    // Validate command string
    if (!command || typeof command !== 'string' || !command.trim()) {
      console.error('Invalid command received:', command);
      return;
    }
    
    // Generate a unique process ID
    const processId = `AI-${Math.random().toString(36).substring(2, 8)}`;

    // Create a new process
    this.processManager.createProcess(processId, command);

    // Start Docker container and command execution
    this.processManager.spawnDockerProcess(processId, command);
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
      const wsSuccess = await this.communicationManager.stopProcess(processId);
      
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
    const { processId, command } = data;

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
      success = await this.communicationManager.sendCommand(processId, command);
      if (success) {
        console.log(`Command sent to process ${processId} successfully via WebSocket`);
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
    const { sendCommandToContainer } = require('./container_manager');

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
    console.log('Received termination signal');

    // Set a maximum time for cleanup (5 seconds) to prevent hanging
    const MAX_CLEANUP_TIME = 5000; // 5 seconds
    let cleanupTimedOut = false;

    const cleanupTimeout = setTimeout(() => {
      console.log('Cleanup taking too long, forcing exit...');
      cleanupTimedOut = true;
      process.exit(0);
    }, MAX_CLEANUP_TIME);

    try {
      await this.cleanup();
      // Cleanup completed normally, clear the timeout
      clearTimeout(cleanupTimeout);
    } catch (error) {
      console.error('Error during cleanup:', error);
      // Make sure we still clear the timeout on error
      clearTimeout(cleanupTimeout);
    }

    // If we haven't timed out, exit with a short delay for final messages
    if (!cleanupTimedOut) {
      setTimeout(() => process.exit(0), 100);
    }
  }

  /**
   * Clean up resources before server shutdown
   */
  private async cleanup(): Promise<void> {
    console.log('MAGI System shutting down - cleaning up resources...');

    // Step 1: Close all WebSocket connections
    try {
      this.communicationManager.closeAllConnections();
    } catch (error: unknown) {
      console.error('Error closing WebSocket connections:', error);
    }

    // Step 2: Clean up processes
    await this.processManager.cleanup();

    // Step 3: Additional cleanup for any containers that might have been missed
    try {
      await cleanupAllContainers();
    } catch (error: unknown) {
      console.error('Error during final container cleanup:', error);
    }

    // Step 4: Save used colors to persist across restarts
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
   * Opens the user's default browser to a URL
   *
   * @param url - The URL to open in the browser
   */
  private openBrowser(url: string): void {
    const platform = process.platform;

    let command: string;
    // Select command based on operating system
    switch (platform) {
      case 'darwin': // macOS
        command = `open ${url}`;
        break;
      case 'win32': // Windows
        command = `start ${url}`;
        break;
      default: // Linux and others
        command = `xdg-open ${url}`;
        break;
    }

    // Execute the command to open the browser
    exec(command, (err: Error | null) => {
      if (err) {
        console.error('Failed to open browser:', err);
        console.log(`Please manually open your browser to: ${url}`);
      }
    });
  }

  /**
   * Start the server and handle container reconnection
   */
  async start(): Promise<void> {
    // Load stored environment variables
    loadAllEnvVars();
    updateServerVersion();

    // Get port from environment or use 3001
    const isNodemonRestart = process.env.HAS_RESTARTED === 'true';
    if (!isNodemonRestart) {
      saveEnvVar('HAS_RESTARTED', 'true');
    }
    const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;
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
      }

      // Handle server errors
      this.server.on('error', (err: unknown) => {
        if (err && typeof err === 'object' && 'code' in err && err.code === 'EADDRINUSE') {
          console.error(`Port ${port} is in use despite port check. Trying a random port...`);
          const randomPort = 8000 + Math.floor(Math.random() * 1000);
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

        // Only open browser on first start, not on nodemon restarts
        if (!isNodemonRestart) {
          this.openBrowser(url);
        }
      });
    } catch (error: unknown) {
      console.error('Failed to start server:', error);
      process.exit(1);
    }
  }
}
