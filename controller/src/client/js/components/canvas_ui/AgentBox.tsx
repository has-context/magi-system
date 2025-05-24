import * as React from 'react';
import { useRef, useEffect, useState } from 'react';
import { processMessages } from '../utils/ProcessBoxUtils';
import { ClientMessage } from '../../context/SocketContext';
import MessageList from '../message/MessageList';
import ProcessHeader from '../ui/ProcessHeader';
import {
    ProcessStatus,
    ScreenshotEvent,
    type ConsoleEvent,
    DesignEvent,
} from '../../../../types/shared-types';
import AutoScrollContainer from '../ui/AutoScrollContainer';
import BrowserDisplay from '../ui/BrowserDisplay';
import ConsoleDisplay from '../ui/ConsoleDisplay';
import DesignDisplay from '../ui/DesignDisplay';

interface AgentBoxProps {
    id: string;
    status: ProcessStatus;
    colors: {
        rgb: string;
        bgColor: string;
        textColor: string;
    };
    logs: string;
    agentName: string;
    messages: ClientMessage[];
    isTyping: boolean;
    screenshots?: ScreenshotEvent[];
    designEvents?: DesignEvent[];
    consoleEvents?: ConsoleEvent[];
}

interface AgentBoxWithParentProcess extends AgentBoxProps {
    parentProcessId?: string;
    onFocusAgent?: (
        agentId: string,
        parentProcessId: string,
        focusMode: 'parent-and-children' | 'only-box'
    ) => void;
}

const AgentBox: React.FC<AgentBoxWithParentProcess> = ({
    id,
    status,
    colors,
    agentName,
    messages,
    isTyping,
    parentProcessId,
    onFocusAgent,
    screenshots,
    designEvents,
    consoleEvents,
}) => {
    const clickTimeout = useRef<number | null>(null);
    const clickCount = useRef<number>(0);
    const [mounted, setMounted] = useState(false);
    const heavyAgent = ['browser', 'code', 'design'].some(t =>
        agentName.toLowerCase().includes(t)
    );
    const displayMessages = heavyAgent
        ? messages
        : processMessages(messages).slice(-1);

    // Effect to handle mount animation
    useEffect(() => {
        setMounted(true);
    }, []);

    // Handle click on agent box
    const handleBoxClick = (e: React.MouseEvent<HTMLDivElement>) => {
        // Check what was clicked
        const target = e.target as HTMLElement;

        // Check if clicking on header controls or not an interactive area
        const isClickingControls =
            target.classList.contains('process-status') ||
            !!target.closest('.process-btn');

        if (!isClickingControls) {
            // Increment click count
            clickCount.current += 1;

            // Clear any existing timeout
            if (clickTimeout.current !== null) {
                window.clearTimeout(clickTimeout.current);
            }

            if (clickCount.current === 1) {
                // Add a brief delay to allow for a double click event
                clickTimeout.current = window.setTimeout(() => {
                    // Single click - focus only on this agent box
                    onFocusAgent(id, parentProcessId, 'only-box');

                    // Add some extra time to detect double clicks
                    clickTimeout.current = window.setTimeout(() => {
                        // Reset click count after handling
                        clickCount.current = 0;
                        clickTimeout.current = null;
                    }, 300);
                }, 200);
            } else {
                if (clickCount.current === 2) {
                    // Double click - focus on parent and all children
                    onFocusAgent(id, parentProcessId, 'parent-and-children');
                }

                // Clear after 1 second to allow next event
                clickTimeout.current = window.setTimeout(() => {
                    // Reset click count after handling
                    clickCount.current = 0;
                    clickTimeout.current = null;
                }, 500);
            }

            // Stop event propagation to prevent bubbling
            e.stopPropagation();
        }
    };

    return (
        <div
            className={`process-box agent-box card border-0 shadow ${mounted && status !== 'terminated' && status !== 'completed' ? 'mounted' : ''}`}
            onClick={handleBoxClick}
        >
            <div
                className="process-box-bg"
                style={{ backgroundColor: colors.bgColor }}
            >
                <ProcessHeader agentName={agentName} colors={colors} />

                {screenshots && screenshots.length > 0 && (
                    <BrowserDisplay
                        screenshots={screenshots}
                        collapsible={true}
                    />
                )}
                {!(screenshots && screenshots.length > 0) &&
                    designEvents &&
                    designEvents.length > 0 && (
                        <DesignDisplay
                            designs={designEvents}
                            collapsible={true}
                        />
                    )}
                {!(screenshots && screenshots.length > 0) &&
                    !(designEvents && designEvents.length > 0) &&
                    consoleEvents &&
                    consoleEvents.length > 0 && (
                        <ConsoleDisplay
                            consoleEvents={consoleEvents}
                            collapsible={true}
                        />
                    )}

                <AutoScrollContainer className="process-logs card-body">
                    <MessageList
                        messages={displayMessages}
                        isTyping={isTyping}
                        colors={colors}
                    />
                </AutoScrollContainer>
            </div>
        </div>
    );
};

export default AgentBox;
