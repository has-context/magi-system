/**
 * ProcessBox Component
 * Renders a process card with messages, status, and input controls
 */
import React from 'react';
import { useRef, useEffect, useState } from 'react';
import { ProcessStatus } from '../../../../types';
import { useSocket } from '../../context/SocketContext';
import MessageList from '../message/MessageList';
import ProcessHeader from '../ui/ProcessHeader';
import AutoScrollContainer from '../ui/AutoScrollContainer';

interface ProcessBoxProps {
    id: string;
    isCoreProcess: boolean;
    name: string;
    command: string;
    status: ProcessStatus;
    colors: {
        rgb: string;
        bgColor: string;
        textColor: string;
    };
    logs: string;
    focused: boolean;
    onFocus: (
        id: string,
        focusMode?: 'parent-and-children' | 'only-box'
    ) => void;
    onViewLogs?: (id: string) => void;
}

/**
 * The ProcessBox component is the main container for a process
 * It displays process information, messages, and handles user input
 */
const ProcessBox: React.FC<ProcessBoxProps> = ({
    id,
    isCoreProcess,
    name,
    status,
    colors,
    focused,
    onFocus,
    onViewLogs,
}) => {
    const { terminateProcess, processes } = useSocket();
    const [mounted, setMounted] = useState(false);

    // Get data directly from the socket context
    const process = processes.get(id);
    const messages = process ? process.agent.messages : [];
    const agentName = process?.agent.name;
    const isTyping = process?.agent.isTyping || false;
    const heavyAgent = agentName
        ? ['browser', 'code', 'design'].some(t =>
              agentName.toLowerCase().includes(t)
          )
        : false;

    // Effect to handle mount animation
    useEffect(() => {
        setMounted(true);
    }, []);

    // Handle terminate button click
    const handleTerminate = () => {
        terminateProcess(id);
    };

    // Track click count and timing for single/double click detection
    const clickTimeout = useRef<number | null>(null);
    const clickCount = useRef<number>(0);

    // Handle click on process box
    const handleBoxClick = (e: React.MouseEvent<HTMLDivElement>) => {
        // Check what was clicked
        const target = e.target as HTMLElement;

        // Check if clicking on header controls
        const isClickingControls =
            target.classList.contains('process-status') ||
            target.classList.contains('process-btn') ||
            !!target.closest('.process-btn');

        if (!isClickingControls) {
            // Increment click count
            clickCount.current += 1;

            // Clear any existing timeout
            if (clickTimeout.current !== null) {
                window.clearTimeout(clickTimeout.current);
            }

            // Set timeout to differentiate between single and double clicks
            clickTimeout.current = window.setTimeout(() => {
                // If it was a single click, focus only on this box
                if (clickCount.current === 1) {
                    onFocus(id, 'only-box');
                }
                // If it was a double click, focus on parent and children
                else if (clickCount.current > 1) {
                    onFocus(id, 'parent-and-children');
                }

                // Reset click count
                clickCount.current = 0;
                clickTimeout.current = null;
            }, 400);
        }
    };

    return (
        <div
            className={`process-box card border-0 shadow ${isCoreProcess ? 'core-box' : ''} ${focused ? 'focused' : ''} ${mounted && status !== 'terminated' && status !== 'completed' ? 'mounted' : ''}`}
            onClick={handleBoxClick}
        >
            <div
                className="process-box-bg"
                style={{ backgroundColor: colors.bgColor }}
            >
                <ProcessHeader
                    processName={name}
                    agentName={agentName}
                    status={status}
                    colors={colors}
                    onTerminate={handleTerminate}
                    onViewLogs={onViewLogs ? () => onViewLogs(id) : undefined}
                />

                <AutoScrollContainer className="process-logs card-body">
                    <MessageList
                        agent={process?.agent}
                        messages={messages}
                        isTyping={isTyping}
                        colors={colors}
                        latestOnly={!isCoreProcess && !heavyAgent}
                    />
                </AutoScrollContainer>
            </div>
        </div>
    );
};

export default ProcessBox;
