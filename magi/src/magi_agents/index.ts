/**
 * Agent registry for the MAGI system.
 *
 * This module exports all available agents and provides functions to create them.
 */

import { Agent } from '../utils/agent.js';
import { createReasoningAgent } from './common_agents/reasoning_agent.js';
import { createCodeAgent } from './common_agents/code_agent.js';
import { createBrowserAgent } from './common_agents/browser_agent.js';
import { createSearchAgent } from './common_agents/search_agent.js';
import { createShellAgent } from './common_agents/shell_agent.js';
import { createDesignAgent } from './web_agents/design_agent.js';
import { createOverseerAgent } from './overseer_agent.js';
import { ModelClassID } from '../../../ensemble/model_providers/model_data.js';
import { createOperatorAgent } from './operator_agent.js';
import { createProjectOperatorAgent } from './project_agents/operator_agent.js';
import { createWebOperatorAgent } from './web_agents/operator_agent.js';
import { createResearchOperatorAgent } from './research_agents/operator_agent.js';

// Export all constants from the constants module
export * from './constants.js';

/**
 * Available agent types
 */
export type AgentType =
    | 'quick'
    | 'overseer'
    | 'operator'
    | 'design'
    | 'frontend'
    | 'backend'
    | 'test'
    | 'supervisor'
    | 'reasoning'
    | 'code'
    | 'browser'
    | 'browser_code'
    | 'search'
    | 'shell'
    | 'image';

/**
 * Create an agent of the specified type with optional model override and agent_id
 */
export async function createAgent(
    args: Record<string, unknown>
): Promise<Agent> {
    const {
        agent: type,
        model,
        modelClass,
        agent_id,
        tool,
    } = args as {
        agent: AgentType | ModelClassID;
        model?: string;
        modelClass?: ModelClassID;
        agent_id?: string;
        tool?: string;
    };
    let agent: Agent;

    if (tool && tool !== 'none') {
        switch (tool) {
            case 'project_update':
                agent = await createProjectOperatorAgent();
                break;
            case 'web_code':
                agent = createWebOperatorAgent();
                break;
            case 'research':
                agent = await createResearchOperatorAgent();
                break;
            default:
                agent = createOperatorAgent();
                break;
        }
    } else {
        switch (type) {
            case 'quick':
                agent = createQuickAgent();
                break;
            case 'overseer':
                agent = createOverseerAgent();
                break;
            case 'operator':
                agent = createOperatorAgent();
                break;
            case 'reasoning':
                agent = createReasoningAgent();
                break;
            case 'code':
                agent = createCodeAgent();
                break;
            case 'browser':
                agent = createBrowserAgent();
                break;
            case 'search':
                agent = createSearchAgent();
                break;
            case 'shell':
                agent = createShellAgent();
                break;
            case 'design':
                agent = createDesignAgent();
                break;
            default:
                agent = createQuickAgent(type as ModelClassID);
                break;
        }
    }

    agent.args = args;

    // Override agent_id if specified
    if (agent_id) {
        agent.agent_id = agent_id;
    }

    // Apply model override if specified
    if (model) {
        agent.model = model;
    }

    // Apply model class if specified
    if (modelClass) {
        agent.modelClass = modelClass;
    }

    return agent;
}

function createQuickAgent(modelClass: ModelClassID = 'reasoning_mini'): Agent {
    return new Agent({
        name: 'QuickAgent',
        description: 'Performs quick tasks and provides immediate responses',
        instructions: 'Please think through this step by step.',
        modelClass,
    });
}

// Export all agent creation functions
export {
    createQuickAgent,
    createReasoningAgent,
    createCodeAgent,
    createBrowserAgent,
    createSearchAgent,
    createShellAgent,
    createProjectOperatorAgent,
    createResearchOperatorAgent,
};
