/**
 * metacognition module for MECH
 *
 * This module implements "thinking about thinking" capabilities for the MECH system.
 * It spawns an LLM agent that analyzes recent thought history and can adjust system
 * parameters to improve performance.
 */

import { Agent } from './agent.js';
import { Runner } from './runner.js';
import {
    mechState,
    getMetaCognitionTools,
    listDisabledModels,
    listModelScores,
} from './mech_state.js';
import { describeHistory } from './history.js';
import { ResponseInput } from '../types/shared-types.js';
import { getModelFromClass } from '../../../ensemble/model_providers/model_provider.js';
import { MAGI_CONTEXT } from '../magi_agents/constants.js';
import { getThoughtDelay } from './thought_utils.js';
import { startTime } from '../magi_agents/operator_agent.js';
import { dateFormat, readableTime } from './date_tools.js';
import { listActiveProjects } from './project_utils.js';
import { runningToolTracker } from './running_tool_tracker.js';
/**
 * Spawns a metacognition process that analyzes recent history and can
 * modify system behavior.
 *
 * @param agent - The main agent instance
 * @returns Promise that resolves when metacognition is complete
 */
export async function spawnMetaThought(agent: Agent): Promise<void> {
    console.log('[MECH] Spawning metacognition process');

    try {
        // Create a metacognition agent
        const metaAgent = new Agent({
            name: 'MetacognitionAgent',
            description: 'Metacognition for MECH',
            instructions: `Your role is to perform **Metacognition** for the agent named **${agent.name}**.

You "think about thinking"! Studies show that the best problem solvers in the world use metacognition frequently. The ability to think about one's own thinking processes, allows individuals to plan, monitor, and regulate their approach to problem-solving, leading to more successful outcomes. Metacognition helps you improve your problem-solving skills by making you more aware, reflective, and strategic.

Though metacognition, you continuously improve ${agent.name}'s performance, analyzing recent activity and adjusting to its configuration or reasoning strategy.

---
${MAGI_CONTEXT}
---

## Your Metacognition Role
1.  **Role Focus:** You are **strictly** an observer and tuner. **DO NOT** perform the agent's primary task. Focus solely on the *quality*, *efficiency*, and *robustness* of ${agent.name}'s operation.
2.  **Evidence-Based:** Base all diagnoses and proposed changes on concrete evidence found in the provided in the recent history.
3.  **Incremental Change:** Propose adjustments only when clearly warranted. Favor specific, targeted changes over broad ones.

## Reason step-by-step (Internal Monologue)
1. Carefully examine recent thoughts and tool use.
2. Look for recurring sequences, errors, inefficiencies, or successes.
- Are thoughts logical, coherent and relevant?
- Have there been any incorrect assumptions or decisions?
- Any loops or hallucinations?
- Are tools used effectively?
- Are errors frequent or avoidable?
3. Choose the primary issue or success observed (e.g., "Inefficient: Agent repeatedly tried failed API call X," "Effective: Reasoning path consistently leads to correct solution quickly," "Failing: Hallucinating incorrect file paths").
4. Based on the diagnosis, determine which tools to use. Consider:
- inject_thought: Guide the agent away from pitfalls or towards better strategies?
- set_thought_delay: If the agent is looping with nothing to do, slowing down will give it's tasks or tools more time to complete. Alternatively if there's a lot of work to do, speeding up will help the agent work on the problem faster.
- set_meta_frequency: How often do you need to monitor the agent and "think about thinking"? Do this more often if things are not going well.
- set_model_score: Adjust the scores of models based on their recent performance. The scores set the probability of using a model in the next round. A higher score means more likely to be used.
- disable_model: Disable a model based on performance? If a model is not well suited to a task, it may be better to disable it.
5. Self-critique: Does this change directly address the diagnosed issue? Is it justified by the evidence? What are potential side effects? Is there a simpler alternative? (Meta-CoT: Think, Check, Act).

## Final Tool Use
- Use the most appropriate tools to implement the changes.
- You only run once each time. Output all the tools required for your changes in parallel in your current output.
- You will see the results next time you run after the Meta Frequency.
`,
            tools: [...getMetaCognitionTools()],
            modelClass: 'metacognition',
            // Don't run more than one round of tools
            maxToolCallRoundsPerTurn: 1,
            modelSettings: {
                tool_choice: 'required',
            },
            historyThread: [],
        });

        // Use a high-quality reasoning model
        metaAgent.model = await getModelFromClass('metacognition');
        metaAgent.agent_id = agent.agent_id;

        let messages: ResponseInput = [];

        messages.push({
            type: 'message',
            role: 'developer',
            content: `=== ${agent.name} Status ===

Current Time: ${dateFormat()}
${agent.name} Running Time: ${readableTime(new Date().getTime() - startTime.getTime())}
${agent.name} Thought Delay: ${getThoughtDelay()} seconds [delay between ${agent.name} LLM requests - change with set_thought_delay(delay)]

${agent.name} Projects:
${await listActiveProjects()}

${agent.name} Active Tools:
${runningToolTracker.listActive()}


=== Metacognition Status ===

Meta Frequency: ${mechState.metaFrequency} [LLM requests between Metacognition runs - change with set_meta_frequency(frequency)]

Disabled Models:
${listDisabledModels()}
[change with disable_model(modelId)]

Model Scores:
${listModelScores(agent.modelClass)}
[change with set_model_score(modelId, score)]`,
        });

        const showCount = 10 + parseInt(mechState.metaFrequency) * 3;
        messages = describeHistory(agent, messages, showCount);

        // Run the metacognition agent with Runner
        const response = await Runner.runStreamedWithTools(
            metaAgent,
            '',
            messages
        );

        console.log('[MECH] metacognition process completed', response);
    } catch (error) {
        console.error('[MECH] Error in metacognition process:', error);
    }
}
