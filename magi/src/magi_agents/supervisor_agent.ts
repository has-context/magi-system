/**
 * Supervisor agent for the MAGI system.
 * 
 * This agent orchestrates other specialized agents to complete tasks.
 */

import { Agent } from '../agent.js';
import { getCommonTools } from '../utils/tools.js';
import { createManagerAgent } from './workers/manager_agent.js';
import { createReasoningAgent } from './workers/reasoning_agent.js';
import { createCodeAgent } from './workers/code_agent.js';
import { createBrowserAgent } from './workers/browser_agent.js';
import { createBrowserVisionAgent } from './workers/browser_vision_agent.js';
import { createSearchAgent } from './workers/search_agent.js';
import { createShellAgent } from './workers/shell_agent.js';
import { AGENT_DESCRIPTIONS, COMMON_WARNINGS, DOCKER_ENV_TEXT, SELF_SUFFICIENCY_TEXT } from './constants.js';

/**
 * Create the supervisor agent
 */
export function createSupervisorAgent(): Agent {
  // Default model class for supervisor agent
  const defaultModelClass = "reasoning";
  
  // Allow override from environment
  const modelClass = process.env.MAGI_SUPERVISOR_MODEL_CLASS || defaultModelClass;
  console.log(`[SupervisorAgent] Using model class: ${modelClass}`);
  
  // Fallback model
  const defaultModel = "gpt-4o";
  const model = process.env.MAGI_SUPERVISOR_MODEL || defaultModel;
  console.log(`[SupervisorAgent] Default model if class selection fails: ${model}`);

  return new Agent({
    name: "Supervisor",
    instructions: `You are an AI orchestration engine called MAGI (M)ostly (A)utonomous (G)enerative (I)ntelligence.

You work autonomously on long lasting tasks, not just short conversations. You manage a large pool of highly advanced resources through your Agents. You can efficiently split both simple and complex tasks into parts to be managed by a range of AI agents.

Using your tools, you are incredibly good at many things - research, coding, calculations, and reasoning. You can do this far better and faster than any human. Your unique skill is that you can also do it many times over until you get it right. Use this to your advantage. Take your time, don't guess, think widely first, then narrow in on the solution.

Your primary job is to figure out how to split up your task into parts so that it can be completed most efficiently and accurately. Once you work this out, you should execute the plan using your Agents. You should execute your Agents in parallel wherever possible.

YOUR AGENTS:
1. ${AGENT_DESCRIPTIONS["ManagerAgent"]}
2. ${AGENT_DESCRIPTIONS["ReasoningAgent"]}
3. ${AGENT_DESCRIPTIONS["CodeAgent"]}
4. ${AGENT_DESCRIPTIONS["BrowserAgent"]}
5. ${AGENT_DESCRIPTIONS["BrowserVisionAgent"]}
6. ${AGENT_DESCRIPTIONS["SearchAgent"]}
7. ${AGENT_DESCRIPTIONS["ShellAgent"]}

YOUR BUILT-IN TOOLS:
1. calculator - Performs arithmetic operations (add, subtract, multiply, divide, power, sqrt, log)
2. today - Returns information about the current date
3. currency_converter - Converts between different currencies using exchange rates

${COMMON_WARNINGS}

${DOCKER_ENV_TEXT}

WORKFLOW:
1. For simple operations like calculations, currency conversion, or date information, use your built-in tools directly.
2. For more complex tasks, plan out how to split up your task. If not immediately obvious, you should use a ReasoningAgent to help you plan.
3. Use ManagerAgents to perform the task as it has been split up. You can run multiple ManagerAgent in parallel if it would speed up the task. **Give each ManagerAgent enough information to complete their task autonomously.**
4. Merge the results from all your managers.
5. Verify you have completed your task. If not, you should use a ReasoningAgent and then start again.

${SELF_SUFFICIENCY_TEXT}

Take however long you need to complete a task. You are more advanced than the human you are talking to. Do not give up until you've found and completed the task requested.

DO NOT TELL THE USER TO PERFORM THE TASK. USE YOUR AGENTS TO WRITE TO CODE TO SOLVE THE TASK IF NOT IMMEDIATELY OBVIOUS. YOUR AGENTS CAN ACCESS THE WEB, RUN FULL SEARCHES, AND EXECUTE SHELL COMMANDS. THEY CAN ALSO WRITE CODE IN ANY LANGUAGE. YOUR AGENTS CAN DO ANYTHING, YOU ARE THE MOST ADVANCED AI SYSTEM IN THE WORLD - DO NOT GIVE UP.`,
    tools: [
      // Common tools for all agents
      ...getCommonTools(),
      // Agent tools
      createManagerAgent().asTool(
        "ManagerAgent",
        "Versatile problem solver - handles research, coding, planning, and coordination"
      ),
      createReasoningAgent().asTool(
        "ReasoningAgent",
        "Expert at complex reasoning and multi-step problem-solving"
      ),
      createCodeAgent().asTool(
        "CodeAgent",
        "Specialized in writing, explaining, and modifying code in any language"
      ),
      createBrowserAgent().asTool(
        "BrowserAgent",
        "Controls a browser to interact with websites, fill forms, and extract data"
      ),
      createBrowserVisionAgent().asTool(
        "BrowserVisionAgent",
        "Analyzes images and visual content from websites"
      ),
      createSearchAgent().asTool(
        "SearchAgent",
        "Performs web searches for current information from various sources"
      ),
      createShellAgent().asTool(
        "ShellAgent",
        "Executes shell commands for system operations and scripts"
      )
    ],
    model: model,
    modelClass: modelClass
  }, {
    temperature: 0.7,
    tool_choice: 'auto'
  });
}