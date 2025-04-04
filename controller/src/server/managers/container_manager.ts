/**
 * Container Manager Module
 *
 * Higher-level container management functionality for MAGI System.
 */
import {spawn, execSync} from 'child_process';
import path from 'path';
import fs from 'fs';
import {
	validateContainerName,
	execPromise,
	execPromiseFallback,
} from '../utils/docker_commands';
import {ProcessToolType} from './communication_manager';

export interface DockerBuildOptions {
	tag?: string;
	noCache?: boolean;
	verbose?: boolean;
}

export interface DockerRunOptions {
	processId: string;
	command: string;
	tool?: ProcessToolType;
	coreProcessId?: string;
	project?: string[]; // Array of git repositories to clone and mount
}

/**
 * Build the MAGI System Docker image
 * @param options Build options
 * @returns Promise resolving to true if build was successful, false otherwise
 */
export async function buildDockerImage(options: DockerBuildOptions = {}): Promise<boolean> {
	try {
		const tag = options.tag || 'latest';
		const dockerfilePath = path.resolve(__dirname, '../../../../../magi/docker/Dockerfile');
		const contextPath = path.resolve(__dirname, '../../../../../');

		// Verify dockerfile exists
		if (!fs.existsSync(dockerfilePath)) {
			throw new Error(`Dockerfile not found at ${dockerfilePath}`);
		}

		// Build arguments
		const buildArgs = ['build', '-t', `magi-system:${tag}`, '-f', dockerfilePath, contextPath];
		if (options.noCache) {
			buildArgs.push('--no-cache');
		}

		// Spawn the process
		console.log(`Building Docker image with command: docker ${buildArgs.join(' ')}`);
		const buildProcess = spawn('docker', buildArgs, {stdio: options.verbose ? 'inherit' : 'pipe'});

		// If not verbose, collect and log output
		if (!options.verbose) {
			buildProcess.stdout?.on('data', (data) => {
				console.log(`Docker build output: ${data.toString()}`);
			});

			buildProcess.stderr?.on('data', (data) => {
				console.error(`Docker build error: ${data.toString()}`);
			});
		}

		// Wait for process to complete
		return new Promise<boolean>((resolve) => {
			buildProcess.on('close', (code) => {
				if (code === 0) {
					console.log('Docker image built successfully');
					resolve(true);
				} else {
					console.error(`Docker build failed with code ${code}`);
					resolve(false);
				}
			});
		});
	} catch (error) {
		console.error('Error building Docker image:', error);
		return false;
	}
}

/**
 * Prepare a git repository for use by a container
 *
 * @param processId The process ID
 * @param repo The repository options
 * @returns Object with temporary directory and mount path
 */
async function prepareGitRepository(
	processId: string,
	project: string
): Promise<{ hostPath: string, outputPath: string } | null> {

	// Where the git repository is located on the host
	const hostPath = path.join('/external/host', project);

	// Create a temporary directory for the git repo in the magi_output volume
	const outputPath = path.join('/magi_output', processId, 'projects', project);

	try {
		// Skip if the path doesn't exist on the host
		if (!fs.existsSync(hostPath)) {
			console.error(`Skipping git repository at ${hostPath} - directory does not exist`);
			return null;
		}

		// Check if it's a git repository
		try {
			await execPromise(`git -C "${hostPath}" rev-parse --is-inside-work-tree`);
		} catch (error) {
			console.error(`Can not access git at ${hostPath}`);
			return null;
		}

		// Remove the directory if it exists
		if (fs.existsSync(outputPath)) {
			fs.rmSync(outputPath, { recursive: true, force: true });
		}

		// Create the output directory
		fs.mkdirSync(outputPath, { recursive: true });

		// Clone the repository to the temp directory
		await execPromise(`git clone "${hostPath}" "${outputPath}"`);

		// Create or checkout the branch
		const branchName = `magi-${processId}`;

		// Check if branch exists
		const branchExists = await execPromiseFallback(`git -C "${outputPath}" show-ref --verify --quiet refs/heads/${branchName}`);

		if (branchExists.stderr) {
			// Branch doesn't exist, create it
			await execPromise(`git -C "${outputPath}" checkout -b ${branchName}`);
		} else {
			// Branch exists, checkout
			await execPromise(`git -C "${outputPath}" checkout ${branchName}`);
		}

		// Set git config for commits
		await execPromise(`git -C "${outputPath}" config user.name "MAGI System"`);
		await execPromise(`git -C "${outputPath}" config user.email "magi-system@hascontext.com"`);

		return {
			hostPath,
			outputPath
		};
	} catch (error) {
		console.error(`Error preparing git repository ${outputPath}:`, error);
		return null;
	}
}

/**
 * Create a new project in /external/host with a git repository
 *
 * @param project The repository options
 * @returns The project name (make be changed if already exists)
 */
export function createNewProject(
	project: string,
): string {

	if(!/^[a-zA-Z0-9_-]+$/.test(project)) {
		throw new Error(`Invalid project name '${project}'. Only letters, numbers, dashes and underscores are allowed.`);
	}

	// Make sure we have a unique project name
	let i = 0;
	let finalProjectName = project;
	while(fs.existsSync(path.join('/external/host', finalProjectName))) {
		finalProjectName = 'magi-'+project+(i > 0 ? `-${i}` : '');
		i++;
	}

	// Create a temporary directory for the git repo in the magi_output volume
	const projectPath = path.join('/external/host', finalProjectName);
	fs.mkdirSync(projectPath, { recursive: true });

	try {
		execSync(`git -C "${projectPath}" init`);

		process.env.PROJECT_REPOSITORIES = (process.env.PROJECT_REPOSITORIES+',' || '')+finalProjectName;

		return finalProjectName;
	} catch (error) {
		console.error(`Error preparing git repository ${projectPath}:`, error);
		return '';
	}
}


/**
 * Run a MAGI System Docker container
 * @param options Run options
 * @returns Promise resolving to container ID if successful, empty string if failed
 */
export async function runDockerContainer(options: DockerRunOptions): Promise<string> {
	try {
		const {processId, command} = options;

		// Input validation
		if (!processId || typeof processId !== 'string') {
			throw new Error('Invalid process ID');
		}
		if (!command || typeof command !== 'string') {
			throw new Error('Invalid command');
		}

		const projectRoot = path.resolve(process.cwd(), '..');

		// Generate container name and validate
		const containerName = validateContainerName(`magi-${processId}`);

		// Use base64 encoding to avoid escaping issues entirely
		const base64Command = Buffer.from(command).toString('base64');

		// Get the current server port
		const serverPort = process.env.PORT || '3010';
		console.error('Start docker with CONTROLLER_PORT:', serverPort);

		// Create the docker run command using base64 encoded command
		// Get HOST_HOSTNAME from environment variable, fallback to docker service name
		const hostName = process.env.HOST_HOSTNAME || 'controller';

		// Initialize volume mounts array with default volumes
		const volumeMounts = [
			'-v claude_credentials:/claude_shared:rw',
			'-v magi_output:/magi_output:rw'
		];

		// Mount projects on code process
		const projects = (process.env.PROJECT_REPOSITORIES || '').split(',');
		let workingDir:string;

		// Get PROJECT_REPOSITORIES directories and add them as volume mounts
		if (process.env.PROJECT_PARENT_PATH && options.coreProcessId && options.coreProcessId === processId && projects.length > 0) {
			for (const project of projects) {

				// Ensure path is absolute
				const externalPath = path.resolve(process.env.PROJECT_PARENT_PATH, project);
				const hostPath = path.resolve('/external/host', project);

				// Validate the host directory exists
				if (fs.existsSync(hostPath)) {
					// Add to volume mounts array - mount as read-only for safety
					volumeMounts.push(`-v "${externalPath}:${hostPath}:ro"`);
					if(!workingDir) {
						workingDir = '/external/host';
					}
				} else {
					console.warn(`Skipping mount for non-existent PROJECT_REPOSITORIES directory: ${hostPath}`);
				}
			}
		}

		// Mount git repositories if specified
		const gitProjects = (options.project || []).filter(project => projects.includes(project));
		if (gitProjects.length > 0) {
			// Process each repo
			const projectPromises = gitProjects.map(project => prepareGitRepository(processId, project));
			const projectResults = await Promise.all(projectPromises);

			// Add volume mounts for successful repos
			for (const result of projectResults) {
				if (result) {
					volumeMounts.push(`-v "${result.hostPath}:${result.outputPath}:rw"`);
				}
			}
		}

		if(!workingDir) {
			workingDir = gitProjects.length > 0 ? path.join('/magi_output', processId, 'projects', (gitProjects.length > 1 ? undefined : gitProjects[0])) : '';
		}

		const dockerRunCommand = `docker run -d --rm --name ${containerName} \
      -e PROCESS_ID=${processId} \
      -e HOST_HOSTNAME=${hostName} \
      -e CONTROLLER_PORT=${serverPort} \
      --env-file ${path.resolve(projectRoot, '../.env')} \
      ${volumeMounts.join(' ')} \
      --network magi-system_magi-network \
      magi-system:latest \
      --tool ${options.tool || 'none'} \
      --working "${workingDir}" \
      --base64 "${base64Command}"`;

		console.log('dockerRunCommand', dockerRunCommand);

		// Execute the command and get the container ID
		const result = await execPromise(dockerRunCommand);
		return result.stdout.trim();
	} catch (error) {
		console.error('Error running Docker container:', error);
		return '';
	}
}


/**
 * Commit changes in a git repository and push the branch back to the original repo
 *
 * @param processId The process ID of the container
 * @param project The name of the repository (as mounted in the container)
 * @param message The commit message
 * @returns Promise resolving to true if successful, false otherwise
 */
export async function commitGitChanges(processId: string, project: string, message: string): Promise<boolean> {
	try {

		const outputPath = path.join('/magi_output', processId, 'projects', project);

		if (!fs.existsSync(outputPath)) {
			throw new Error(`Git repository ${project} not found for process ${processId}`);
		}

		// Get the current branch
		const { stdout: branchOutput } = await execPromise(`git -C "${outputPath}" rev-parse --abbrev-ref HEAD`);
		const currentBranch = branchOutput.trim();

		// Check for changes
		const { stdout: statusOutput } = await execPromise(`git -C "${outputPath}" status --porcelain`);
		if (!statusOutput.trim()) {
			console.log(`No changes to commit in ${project}`);
			return true;
		}

		// Add all changes
		await execPromise(`git -C "${outputPath}" add -A`);

		// Commit changes
		await execPromise(`git -C "${outputPath}" commit -m "${message}"`);

		// Find the original repository location from the remote
		const { stdout: remoteUrl } = await execPromise(`git -C "${outputPath}" config --get remote.origin.url`);

		// If this is a local repo path, push changes back to the original
		if (remoteUrl.trim() && !remoteUrl.includes('://') && fs.existsSync(remoteUrl.trim())) {
			const originalRepo = remoteUrl.trim();

			try {
				// Push changes back to original repository
				await execPromise(`git -C "${outputPath}" push origin ${currentBranch}`);
				console.log(`Changes pushed to branch ${currentBranch} in ${originalRepo}`);
			} catch (pushError) {
				// If push fails, the branch might not exist remotely yet
				console.error(`Error pushing to origin: ${pushError}`);
				console.log('Trying to push with --set-upstream');

				try {
					await execPromise(`git -C "${outputPath}" push --set-upstream origin ${currentBranch}`);
					console.log(`Changes pushed to new branch ${currentBranch} in ${originalRepo}`);
				} catch (upstreamError) {
					console.error(`Error pushing with --set-upstream: ${upstreamError}`);
					return false;
				}
			}
		}

		console.log(`Changes committed to ${project} on branch ${currentBranch}`);
		return true;
	} catch (error) {
		console.error('Error committing changes to git repository:', error);
		return false;
	}
}

/**
 * Stop a MAGI System Docker container
 * @param processId The process ID of the container
 * @returns Promise resolving to true if successful, false otherwise
 */
export async function stopDockerContainer(processId: string): Promise<boolean> {
	try {
		const containerName = validateContainerName(`magi-${processId}`);

		// First check if the container exists and is running
		try {
			const {stdout} = await execPromise(`docker container inspect -f '{{.State.Running}}' ${containerName}`);
			const isRunning = stdout.trim() === 'true';

			if (!isRunning) {
				console.log(`Container ${containerName} is not running, skipping stop command`);
				return true;
			}

		} catch (inspectError) {
			// Container doesn't exist, which is fine during cleanup
			console.log(`Container ${containerName} doesn't exist, skipping stop command`);
			return true;
		}

		// Stop the container using docker stop command with a timeout (default is 10 seconds)
		// Use a shorter timeout of 2 seconds to speed up the shutdown process
		await execPromise(`docker stop --time=2 ${containerName}`);

		return true;
	} catch (error) {
		console.error(`Error stopping container for process ${processId}:`, error);
		// We return true here during cleanup to allow the process to continue
		// This prevents one failed container stop from breaking the entire cleanup process
		return true;
	}
}

/**
 * Start monitoring logs from a MAGI System Docker container
 * Note: This is a fallback method for containers that do not use WebSockets
 * The preferred way to get logs is via the CommunicationManager
 *
 * @param processId The process ID of the container
 * @param callback Function to call with each log chunk
 * @returns Function to stop monitoring
 */
export function monitorContainerLogs(
	processId: string,
	callback: (log: string) => void
): () => void {
	try {
		const containerName = validateContainerName(`magi-${processId}`);

		// Start the log process (using spawn as it's easier to stream logs this way)
		const logProcess = spawn('docker', ['logs', '-f', containerName]);

		// Handle stdout
		logProcess.stdout.on('data', (data) => {
			const logData = data.toString();
			callback(logData);

			// Try to parse JSON from logs for backward compatibility
			try {
				// If the log line is valid JSON matching our message format,
				// we can extract structured data from it
				if (logData.trim().startsWith('{') && logData.includes('"type"')) {
					const jsonData = JSON.parse(logData);

					// If this is a valid message with processId, type, and data
					if (jsonData.processId && jsonData.type && jsonData.data) {
						// No need to do anything here - the logs will be processed by the callback
						// This is just to validate that it's a proper message format
					}
				}
			} catch (jsonError) {
				// Not valid JSON or not our format, that's okay
				// This is just plain log data
			}
		});

		// Handle stderr
		logProcess.stderr.on('data', (data) => {
			callback(`[ERROR] ${data.toString()}`);
		});

		// Return function to stop monitoring
		return () => {
			logProcess.kill();
		};
	} catch (error) {
		console.error(`Error monitoring logs for container ${processId}:`, error);
		// Return empty function in case of error
		return () => {
		};
	}
}

/**
 * Get a list of all running MAGI containers
 * @returns Promise resolving to an array of objects containing container info
 */
export async function getRunningMagiContainers(): Promise<{ id: string, containerId: string, command: string }[]> {
	try {
		// Get list of running containers with name starting with 'magi-'
		const {stdout} = await execPromise("docker ps -a --filter 'name=magi-' --filter 'status=running' --format '{{.ID}}|{{.Names}}|{{.Command}}'");

		if (!stdout.trim()) {
			return [];
		}

		// Parse container info and filter out system containers
		return stdout.trim().split('\n')
			.map(line => {
				const [containerId, name, command] = line.split('|');

				// Extract process ID from name (remove 'magi-' prefix)
				const id = name.replace('magi-', '');

				// Extract original command (it's in the format 'python -m... "command"')
				const originalCommandMatch = command.match(/"(.+)"$/);
				const originalCommand = originalCommandMatch ? originalCommandMatch[1] : '';

				return {
					id,
					containerId,
					command: originalCommand
				};
			})
			// Filter out system containers that aren't MAGI LLM process containers
			.filter(container => {
				// Skip controller container and any other system containers
				// Valid MAGI process IDs are in format AI-xxxxx
				return container.id.startsWith('AI-');
			});
	} catch (err) {
		console.error('Error getting running MAGI containers:', err);
		return [];
	}
}

/**
 * Cleanup all MAGI System Docker containers
 * @returns Promise resolving to true if successful, false otherwise
 */
export async function cleanupAllContainers(): Promise<boolean> {
	try {
		// First approach: Stop any containers with magi-AI prefix (the ones we create for processes)
		try {
			console.log('Attempt 1: Stopping all AI process containers');
			const stopAICommand = "docker ps -a --filter 'name=magi-AI' -q | xargs -r docker stop --time=2 2>/dev/null || true";
			await execPromise(stopAICommand);

			// Force remove those containers
			const removeAICommand = "docker ps -a --filter 'name=magi-AI' -q | xargs -r docker rm -f 2>/dev/null || true";
			await execPromise(removeAICommand);

			// Print what containers are still running
			console.log('Post AI cleanup container check:');
			await execPromise("docker ps --filter 'name=magi-AI' --format '{{.Names}}' | xargs -r echo 'Still running: '");
		} catch (commandError) {
			console.error('Error during AI container cleanup:', commandError);
		}

		// Second approach: Try to clean up all magi- containers
		try {
			console.log('Attempt 2: Stopping all containers with magi- prefix');
			// First attempt to stop all containers with name starting with magi- with a 2 second timeout
			const stopCommand = "docker ps -a --filter 'name=magi-' -q | xargs -r docker stop --time=2 2>/dev/null || true";
			await execPromise(stopCommand);

			// Then try to forcefully remove any containers with the magi-system image
			const removeCommand = "docker ps -a --filter 'ancestor=magi-system:latest' -q | xargs -r docker rm -f 2>/dev/null || true";
			await execPromise(removeCommand);
		} catch (commandError) {
			console.error('Error during general container cleanup:', commandError);
		}

		// Third approach: More targeted explicit cleanup with container names
		try {
			console.log('Attempt 3: Explicit container cleanup by name');
			// First, get both running and stopped containers with magi-AI prefix
			const {stdout: aiContainerStdout} = await execPromise("docker ps -a --filter 'name=magi-AI' --format '{{.Names}}'");

			if (aiContainerStdout.trim()) {
				const aiContainerNames = aiContainerStdout.trim().split('\n');
				console.log(`Found ${aiContainerNames.length} AI containers to clean up: ${aiContainerNames.join(', ')}`);

				// First stop all AI containers in parallel
				await Promise.all(
					aiContainerNames.map(async (containerName) => {
						try {
							console.log(`Stopping AI container ${containerName}`);
							await execPromise(`docker stop --time=2 ${containerName}`);
						} catch (containerError) {
							console.error(`Error stopping AI container ${containerName}:`, containerError);
						}
					})
				);

				// Then remove all AI containers in parallel
				await Promise.all(
					aiContainerNames.map(async (containerName) => {
						try {
							console.log(`Removing AI container ${containerName}`);
							await execPromise(`docker rm -f ${containerName}`);
						} catch (containerError) {
							console.error(`Error removing AI container ${containerName}:`, containerError);
						}
					})
				);
			}

			// Next, get all other magi containers
			const {stdout} = await execPromise("docker ps -a --filter 'name=magi-' --format '{{.Names}}'");

			if (stdout.trim()) {
				const containerNames = stdout.trim().split('\n');
				console.log(`Found ${containerNames.length} other MAGI containers to clean up: ${containerNames.join(', ')}`);

				// First stop all containers in parallel
				await Promise.all(
					containerNames.map(async (containerName) => {
						try {
							console.log(`Stopping container ${containerName}`);
							await execPromise(`docker stop --time=2 ${containerName}`);
						} catch (containerError) {
							console.error(`Error stopping container ${containerName}:`, containerError);
						}
					})
				);

				// Then remove all containers in parallel
				await Promise.all(
					containerNames.map(async (containerName) => {
						try {
							console.log(`Removing container ${containerName}`);
							await execPromise(`docker rm -f ${containerName}`);
						} catch (containerError) {
							console.error(`Error removing container ${containerName}:`, containerError);
						}
					})
				);
			}
		} catch (listError) {
			console.error('Error listing containers for cleanup:', listError);
		}

		// Final verification: Are there still any containers left?
		try {
			console.log('Final verification of container cleanup');
			const {stdout: finalCheck} = await execPromise("docker ps -a --filter 'name=magi-' --format '{{.Names}}'");

			if (finalCheck.trim()) {
				console.log(`WARNING: After all cleanup attempts, still found containers: ${finalCheck.trim()}`);
				// One last desperate attempt with force
				console.log('Performing final force cleanup');
				await execPromise("docker ps -a --filter 'name=magi-' -q | xargs -r docker rm -f");
			} else {
				console.log('All containers successfully removed');
			}
		} catch (finalError) {
			console.error('Error in final verification:', finalError);
		}

		return true;
	} catch (error) {
		console.error('Error in cleanupAllContainers:', error);
		// Still return true to allow the shutdown process to continue

		// Even in case of error, try one last time to clean up
		try {
			console.log('Emergency cleanup after error');
			await execPromise("docker ps -a --filter 'name=magi-' -q | xargs -r docker rm -f 2>/dev/null || true");
		} catch (e) {
			// Ignore any errors in this last-ditch effort
		}

		return true;
	}
}
