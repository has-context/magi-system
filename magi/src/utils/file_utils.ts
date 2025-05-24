/**
 * File utility functions for the MAGI system.
 */

// Global directory path for this process
let processDirectory: string | null = null;
let testMode = false;

import fs from 'fs';
import path from 'path';
import { ResponseInput, ToolFunction } from '../types/shared-types.js';
import { createToolFunction } from './tool_call.js';
import { ModelProviderID } from '../../../ensemble/model_providers/model_data.js';
// Child process utilities are used via dynamic imports in functions below

export function set_file_test_mode(mode: boolean): void {
    testMode = mode;
}

/**
 * Create or get the directory in /magi_output for the current process and a given subdirectory
 * The output dir is where MAGI can write to persistent, isolated storage. It can be accessed by the controller and future MAGI processes.
 *
 * @param subdirectory - The subdirectory to create or access
 * @returns The path to the created directory
 */
export function get_output_dir(subdirectory?: string): string {
    if (!processDirectory) {
        // Use a relative path for test mode, absolute path otherwise
        const baseOutputDir = testMode ? './test_output' : '/magi_output';
        // Ensure the base directory exists in test mode
        if (testMode && !fs.existsSync(baseOutputDir)) {
            fs.mkdirSync(baseOutputDir, { recursive: true });
        }
        processDirectory = path.join(
            baseOutputDir,
            process.env.PROCESS_ID || 'test-process'
        );
        console.log(`Output directory determined: ${processDirectory}`);
    }
    const outputDirectory = subdirectory
        ? path.join(processDirectory, subdirectory)
        : processDirectory;
    // Ensure the specific output directory exists
    if (!fs.existsSync(outputDirectory)) {
        fs.mkdirSync(outputDirectory, { recursive: true });
        console.log(`Created directory: ${outputDirectory}`);
    }
    return outputDirectory;
}

/**
 * Convince function to get the working output directory
 * The working directory is where MAGI works with existing code bases
 *
 * @returns The path to the working directory
 */
export function get_working_dir(): string {
    return get_output_dir('working');
}

/**
 * Move to the working directory for this process and create it if it doesn't exist
 */
export function move_to_working_dir(working?: string): void {
    process.chdir(get_output_dir(working || 'working'));
}

/**
 * Get a list of all git projects
 *
 * @returns Object mapping repository names to full paths
 */
export function get_git_repositories(): Record<string, string> {
    const gitDir = get_output_dir('projects');
    const result: Record<string, string> = {};

    try {
        if (fs.existsSync(gitDir)) {
            const repos = fs.readdirSync(gitDir);
            for (const repo of repos) {
                const fullPath = path.join(gitDir, repo);
                // Verify it's a directory and contains a .git folder
                if (
                    fs.statSync(fullPath).isDirectory() &&
                    fs.existsSync(path.join(fullPath, '.git'))
                ) {
                    result[repo] = fullPath;
                }
            }
        }
    } catch (error) {
        console.error(`Error reading git repositories: ${error}`);
    }

    return result;
}

/**
 * Read a file from the file system
 *
 * @param file_path - Path to the file to read
 * @param line_start - Starting line to retrieve (0-based), optional
 * @param line_end - Ending line to retrieve (0-based), optional
 * @param max_chars - Maximum number of characters to return (default: 1000), optional
 * @returns File contents as a string
 */
export function read_file(
    file_path: string,
    line_start?: number,
    line_end?: number,
    max_chars: number = 1000
): string {
    try {
        let content: string;

        // Get file content (either full file or specific line range)
        if (line_start === undefined && line_end === undefined) {
            content = fs.readFileSync(file_path, 'utf-8');
        } else {
            // Read the file and split into lines
            const fileContent = fs.readFileSync(file_path, 'utf-8');
            const lines = fileContent.split('\n');

            // Validate line numbers
            const start =
                line_start !== undefined ? Math.max(0, line_start) : 0;
            const end =
                line_end !== undefined
                    ? Math.min(lines.length - 1, line_end)
                    : lines.length - 1;

            // Get specified range of lines
            if (start <= end) {
                content = lines.slice(start, end + 1).join('\n');
            } else {
                return ''; // Return empty string for invalid range
            }
        }

        // Apply character limit if needed
        if (content.length > max_chars) {
            const truncated = content.substring(0, max_chars);
            const remainingChars = content.length - max_chars;
            return `${truncated}\n\n... Content truncated (${remainingChars} more characters)`;
        }

        return content;
    } catch (error) {
        throw new Error(`Error reading file ${file_path}: ${error}`);
    }
}

/**
 * Write content to a file
 *
 * @param file_path - Path to write the file to
 * @param content - Content to write to the file
 * @returns Success message with the path
 */
export function write_file(
    file_path: string,
    content: string | ArrayBuffer
): string {
    try {
        // Ensure the directory exists
        const directory = path.dirname(file_path);
        if (!fs.existsSync(directory)) {
            fs.mkdirSync(directory, { recursive: true });
        }

        // Write the file
        if (typeof content === 'string') {
            fs.writeFileSync(file_path, content, 'utf-8');
        } else {
            // For ArrayBuffer, convert to Buffer and don't specify text encoding
            fs.writeFileSync(file_path, Buffer.from(content));
        }

        return `File written successfully to ${file_path}`;
    } catch (error) {
        throw new Error(`Error writing file ${file_path}: ${error}`);
    }
}

/**
 * Writes content to a file, ensuring the filename is unique.
 * If the initial file_path exists, it appends a counter (e.g., "file (1).txt", "file (2).txt")
 * to the base filename until a unique name is found before writing.
 *
 * @param file_path - The desired initial path to write the file to.
 * @param content - Content to write to the file (string or ArrayBuffer).
 * @returns Success message with the actual path the file was written to.
 * @throws {Error} If there's an error determining the unique path or writing the file.
 */
export function write_unique_file(
    file_path: string,
    content: string | ArrayBuffer
): string {
    try {
        let uniqueFilePath = file_path;
        let counter = 1;
        const directory = path.dirname(file_path);
        const extension = path.extname(file_path);
        const baseName = path.basename(file_path, extension);

        let unique_info = '';
        // Check if the file exists and find a unique name if it does
        // Use a loop that continues as long as the generated path exists
        while (fs.existsSync(uniqueFilePath)) {
            // Construct the new file path with the counter
            uniqueFilePath = path.join(
                directory,
                `${baseName} (${counter})${extension}`
            );
            counter++;
            unique_info = 'File already exists, updated filename. ';
        }

        // Call the original write_file function with the determined unique path
        // This reuses the directory creation and writing logic.
        return unique_info + write_file(uniqueFilePath, content);
    } catch (error) {
        // Catch potential errors from fs.existsSync or the write_file call
        const err = error instanceof Error ? error : new Error(String(error));
        // Provide more specific context for the error source
        throw new Error(
            `Error in write_unique_file attempting path ${file_path}: ${err.message}`
        );
    }
}

/**
 * Commit changes to a git repository
 *
 * @param repoName - Name of the git repository
 * @param message - Commit message
 * @returns Success message
 */
export async function commit_git_changes(
    repoName: string,
    message: string
): Promise<string> {
    const gitRepos = get_git_repositories();

    if (!gitRepos[repoName]) {
        throw new Error(
            `Git repository '${repoName}' not found. Available repositories: ${Object.keys(gitRepos).join(', ')}`
        );
    }

    const repoPath = gitRepos[repoName];

    try {
        // Check if there are any changes to commit
        const { execSync } = await import('child_process');
        const status = execSync(`git -C "${repoPath}" status --porcelain`)
            .toString()
            .trim();

        if (!status) {
            return `No changes to commit in repository '${repoName}'`;
        }

        // Add all changes
        execSync(`git -C "${repoPath}" add -A`);

        // Commit changes
        execSync(`git -C "${repoPath}" commit -m "${message}"`);

        // Get the current branch
        const branch = execSync(
            `git -C "${repoPath}" rev-parse --abbrev-ref HEAD`
        )
            .toString()
            .trim();

        return `Changes committed to repository '${repoName}' on branch '${branch}'`;
    } catch (error) {
        console.error(
            `Error committing changes to repository '${repoName}': ${error}`
        );
        throw error;
    }
}

export function addFileStatus(messages: ResponseInput): ResponseInput {
    // Add system status to the messages
    let content = `You are currently running in the ${process.cwd()} directory.`;

    const gitRepos = get_git_repositories();
    const projects = Object.values(gitRepos);
    if (projects.length > 0) {
        content += `\n\nYou have access to the following projects (and git repositories):\n- ${projects.join('\n- ')}`;
    }

    messages.push({
        type: 'message',
        role: 'developer',
        content,
    });

    return messages;
}

/**
 * Get all file tools as an array of tool definitions
 */
export function getFileTools(): ToolFunction[] {
    return [
        createToolFunction(
            read_file,
            'Read a file from the file system',
            {
                file_path: {
                    type: 'string',
                    description:
                        'Path to the file to read. If possible, limit lines to avoid loading too many tokens.',
                },
                line_start: {
                    type: 'number',
                    description: 'Starting line to retrieve (0-based).',
                    optional: true,
                },
                line_end: {
                    type: 'number',
                    description: 'Ending line to retrieve (0-based).',
                    optional: true,
                },
                max_chars: {
                    type: 'number',
                    description:
                        'Maximum number of characters to return (default: 1000).',
                    optional: true,
                },
            },
            'File contents as a string'
        ),
        createToolFunction(
            write_file,
            'Write content to a file',
            {
                file_path: 'Path to write the file to',
                content: 'Content to write to the file',
            },
            'Success message with the path'
        ),
    ];
}

/**
 * Recursively processes an object to truncate base64 image data strings.
 *
 * @param obj The object to process
 * @returns A new object with truncated image data strings
 */
/**
 * Truncates a long base64 string to a reasonable length.
 *
 * @param str The string to truncate
 * @param maxLength The maximum length to keep after the prefix (default: 50)
 * @returns The truncated string
 */
function truncateBase64String(str: string, maxLength: number = 50): string {
    if (str.length <= maxLength) return str;

    const charsToRemove = str.length - maxLength;
    return (
        str.substring(0, maxLength) +
        `... [${charsToRemove} characters removed]`
    );
}

/**
 * Recursively processes an object to truncate base64 image data strings and any string values over 2000 characters.
 *
 * @param obj The object to process
 * @returns A new object with truncated values
 */
export function truncateLargeValues(obj: any): any {
    if (obj === null || obj === undefined) {
        return obj;
    }

    if (typeof obj === 'string') {
        let resultString = obj;

        // First check if the string is just long and needs to be truncated (>2000 chars)
        if (resultString.length > 2000) {
            const charsToRemove = resultString.length - 2000;
            const keep = 1000; // retain 1k at each end
            return (
                resultString.substring(0, keep) +
                `... [${charsToRemove} characters removed] ...` +
                resultString.slice(-keep)
            );
        }

        // Then check if string contains image data anywhere within it
        const dataImgPattern = /data:image\/[^;]+;base64,/g;
        let match;

        // Find all occurrences of data:image pattern
        while ((match = dataImgPattern.exec(resultString)) !== null) {
            const startPos = match.index;
            const prefixEndPos = startPos + match[0].length;

            // Determine where to truncate (keep prefix + 50 chars of base64 data)
            const truncateAfter = prefixEndPos + 50;

            // Only truncate if there's enough content after the prefix
            if (resultString.length > truncateAfter) {
                // Find a comma or other delimiter after the truncation point if possible
                let endPos = resultString.indexOf(',', truncateAfter);
                if (endPos === -1 || endPos > truncateAfter + 100) {
                    endPos = truncateAfter;
                }

                // Calculate how many characters will be removed
                const charsToRemove = resultString.length - endPos - 1;

                if (charsToRemove > 0) {
                    // Find where the current base64 data likely ends - look for the next data:image pattern or end of string
                    let nextImgStart = resultString.indexOf(
                        'data:image/',
                        endPos
                    );
                    if (nextImgStart === -1) nextImgStart = resultString.length;

                    // Create truncated string - keep content before truncation point, add truncation message, then include rest of string
                    resultString =
                        resultString.substring(0, endPos) +
                        `... [${charsToRemove} characters removed]` +
                        resultString.substring(nextImgStart);

                    // Reset regex to continue from new position
                    dataImgPattern.lastIndex = endPos + 5;
                }
            }
        }

        return resultString;
    }

    if (typeof obj === 'object') {
        if (Array.isArray(obj)) {
            return obj.map(item => truncateLargeValues(item));
        } else {
            const result: Record<string, any> = {};

            // First check if this object is an image data structure with mimeType and data fields
            if (
                obj.mimeType &&
                typeof obj.mimeType === 'string' &&
                obj.mimeType.includes('image/') &&
                obj.data &&
                typeof obj.data === 'string' &&
                obj.data.length > 100
            ) {
                // This is likely an image data object with structure {mimeType: 'image/...', data: '...'}
                return {
                    ...obj,
                    data: truncateBase64String(obj.data),
                };
            }

            // Handle special case for inlineData structure
            if (
                obj.inlineData &&
                typeof obj.inlineData === 'object' &&
                obj.inlineData.mimeType &&
                typeof obj.inlineData.mimeType === 'string' &&
                obj.inlineData.mimeType.includes('image/') &&
                obj.inlineData.data &&
                typeof obj.inlineData.data === 'string' &&
                obj.inlineData.data.length > 100
            ) {
                // This is likely an object with inlineData structure
                return {
                    ...obj,
                    inlineData: {
                        ...obj.inlineData,
                        data: truncateBase64String(obj.inlineData.data),
                    },
                };
            }

            // Process all properties recursively
            for (const [key, value] of Object.entries(obj)) {
                result[key] = truncateLargeValues(value);
            }
            return result;
        }
    }

    return obj;
}

/**
 * Log LLM request data to a file in the output directory.
 *
 * @param agentId agent ID to associate with the log
 * @param providerName Name of the LLM provider (e.g., 'openai', 'claude')
 * @param model Model name used for the request
 * @param requestData The request data to log
 * @param timestamp Optional timestamp (defaults to current time)
 * @returns ID (file path) that can be used with log_llm_response to add response data
 */
export function log_llm_request(
    agentId: string,
    providerName: ModelProviderID,
    model: string,
    requestData: any,
    timestamp: Date = new Date()
): string {
    try {
        if (testMode) {
            console.log(
                `[${providerName} - ${timestamp.toISOString().substring(11, 19)}]`
            );
            console.dir(
                {
                    model,
                    request: truncateLargeValues(requestData),
                },
                { depth: 10, colors: true }
            );
            return '';
        }

        // Create logs directory if needed
        const logsDir = get_output_dir('logs/llm');

        // Format timestamp for filename
        const formattedTime = timestamp.toISOString().replaceAll(/[:./]/g, '-');
        const fileName = `${formattedTime}_${model.replaceAll(/[:./]/g, '-')}.json`;
        const file_path = path.join(logsDir, fileName);

        // Add timestamp and agent ID to the logged data
        const logData = {
            timestamp: timestamp.toISOString(),
            provider: providerName,
            model,
            agent_id: agentId,
            request: truncateLargeValues(requestData),
        };

        // Write the log file
        fs.writeFileSync(file_path, JSON.stringify(logData, null, 2), 'utf8');

        return file_path;
    } catch (err) {
        console.error('Error logging LLM request:', err);
        return '';
    }
}

/**
 * Log LLM response data by adding it to an existing request log file.
 *
 * @param requestId The file path returned from a previous log_llm_request call
 * @param providerName Name of the LLM provider (e.g., 'openai', 'claude')
 * @param model Model name used for the response
 * @param responseData The response data to log
 * @param timestamp Optional timestamp (defaults to current time)
 */
export function log_llm_response(
    requestId: string | undefined,
    responseData: any,
    timestamp: Date = new Date()
): void {
    if (!requestId) return;

    try {
        if (testMode) {
            console.log(
                `[Response - ${timestamp.toISOString().substring(11, 19)}]`
            );
            console.dir(
                {
                    response: truncateLargeValues(responseData),
                },
                { depth: 10, colors: true }
            );
            return;
        }

        // Check if the request file exists
        if (!requestId || !fs.existsSync(requestId)) {
            console.error(`Request file not found: ${requestId}`);
            return;
        }

        // Read and parse the existing log file
        const existingData = JSON.parse(fs.readFileSync(requestId, 'utf8'));

        // Add response data to the log
        existingData.response_timestamp = timestamp.toISOString();
        existingData.response = truncateLargeValues(responseData);

        // Write the updated log file
        fs.writeFileSync(
            requestId,
            JSON.stringify(existingData, null, 2),
            'utf8'
        );
    } catch (err) {
        console.error('Error logging LLM response:', err);
    }
}

/**
 * Log LLM error data by adding it to an existing request log file's error array.
 *
 * @param requestId The file path returned from a previous log_llm_request call
 * @param errorData The error data to log
 * @param timestamp Optional timestamp (defaults to current time)
 */
export function log_llm_error(
    requestId: string | undefined,
    errorData: any,
    timestamp: Date = new Date()
): void {
    if (!requestId) {
        console.error(
            'log_llm_error failed: requestId is undefined',
            requestId,
            truncateLargeValues(errorData)
        );
        return;
    }
    try {
        if (testMode) {
            console.log(
                `[Error - ${timestamp.toISOString().substring(11, 19)}]`
            );
            console.dir(
                {
                    error: truncateLargeValues(errorData),
                },
                { depth: 10, colors: true }
            );
            return;
        }

        // Check if the request file exists
        if (!requestId || !fs.existsSync(requestId)) {
            console.error(`Request file not found: ${requestId}`);
            return;
        }

        // Read and parse the existing log file
        const existingData = JSON.parse(fs.readFileSync(requestId, 'utf8'));

        // Add error data to the log
        existingData.errors = existingData.errors || [];
        existingData.errors.push({
            timestamp: timestamp.toISOString(),
            error: truncateLargeValues(errorData),
        });

        // Write the updated log file
        fs.writeFileSync(
            requestId,
            JSON.stringify(existingData, null, 2),
            'utf8'
        );
    } catch (err) {
        console.error('Error logging LLM error:', err);
    }
}

/**
 * Get all LLM request logs in chronological order.
 *
 * @returns Array of log file paths
 */
export function get_llm_logs(): string[] {
    try {
        const logsDir = get_output_dir('logs/llm');
        if (!fs.existsSync(logsDir)) {
            return [];
        }

        // Get all .json files and sort by name (which includes timestamp)
        const logFiles = fs
            .readdirSync(logsDir)
            .filter(file => file.endsWith('.json'))
            .sort();

        return logFiles.map(file => path.join(logsDir, file));
    } catch (err) {
        console.error('Error getting LLM logs:', err);
        return [];
    }
}
