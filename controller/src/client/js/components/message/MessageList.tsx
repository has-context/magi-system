/**
 * MessageList Component
 * Renders a list of messages with proper formatting
 */
import * as React from 'react';
import {
    AgentData,
    ClientMessage,
    ToolCallMessage as ToolCallMessageType,
    ToolResultMessage as ToolResultMessageType,
} from '../../context/SocketContext';
import { processMessages } from '../utils/ProcessBoxUtils';
import UserMessage from './UserMessage';
import AssistantMessage from './AssistantMessage';
import ToolCallMessage from './ToolCallMessage';
import ToolResultMessage from './ToolResultMessage';
import SystemMessage from './SystemMessage';

interface MessageListProps {
    agent?: AgentData;
    messages: ClientMessage[];
    isTyping?: boolean;
    colors?: {
        rgb: string;
        bgColor: string;
        textColor: string;
    };
    /** Only display the most recent message */
    latestOnly?: boolean;
}

const MessageList: React.FC<MessageListProps> = ({
    agent,
    messages,
    isTyping,
    colors,
    latestOnly,
}) => {
    colors = colors || {
        rgb: '0 0 0',
        bgColor: '#000000',
        textColor: '#000000',
    };

    // If no structured messages, render raw logs with markdown
    if (messages.length === 0) {
        return (
            <>
                {agent?.model && (
                    <div className="message-header">
                        Starting ({agent.model})...
                    </div>
                )}
                {renderTypingIndicator(isTyping, colors.textColor)}
            </>
        );
    }

    // Process messages to handle deltas and sorting
    const filteredMessages = processMessages(messages);
    const messagesToRender = latestOnly
        ? filteredMessages.slice(-1)
        : filteredMessages;

    return (
        <div className="message-container">
            {messagesToRender.map((message, index) =>
                renderMessage(message, colors.rgb, messagesToRender, index)
            )}
            {renderTypingIndicator(isTyping, colors.textColor)}
        </div>
    );
};

/**
 * Render a typing indicator when the assistant is thinking
 */
const renderTypingIndicator = (isTyping: boolean, textColor: string) => {
    if (!isTyping) return null;

    return (
        <span
            className="typing-indicator"
            title="Agent is thinking..."
            style={{ color: textColor }}
        >
            <span className="dot"></span>
            <span className="dot"></span>
            <span className="dot"></span>
        </span>
    );
};

/**
 * Render a message based on its type
 */
const renderMessage = (
    message: ClientMessage,
    rgb: string,
    filteredMessages: ClientMessage[],
    index: number
) => {
    const lastMessage: ClientMessage | undefined =
        filteredMessages[index - 1] || undefined;
    const nextMessage: ClientMessage | undefined =
        filteredMessages[index + 1] || undefined;
    switch (message.type) {
        case 'user':
            return <UserMessage key={message.id} message={message} />;

        case 'assistant':
            return (
                <AssistantMessage
                    key={message.id}
                    message={message}
                    rgb={rgb}
                    isLast={index === filteredMessages.length - 1}
                />
            );

        case 'tool_call': {
            const toolCallMessage = message as ToolCallMessageType;
            let complete = false;
            for (let i = index + 1; i < filteredMessages.length; i++) {
                const resultMessage = filteredMessages[i];
                if (
                    resultMessage.type === 'tool_result' &&
                    (resultMessage as ToolResultMessageType).toolCallId ===
                        toolCallMessage.toolCallId
                ) {
                    complete = true;
                    break;
                }
            }
            const nextToolResultMessage =
                nextMessage && nextMessage.type === 'tool_call'
                    ? (nextMessage as ToolResultMessageType)
                    : undefined;
            return (
                <ToolCallMessage
                    key={toolCallMessage.id}
                    message={toolCallMessage}
                    rgb={rgb}
                    complete={complete}
                    callFollows={
                        nextToolResultMessage &&
                        nextToolResultMessage.toolCallId ===
                            toolCallMessage.toolCallId
                    }
                />
            );
        }

        case 'tool_result': {
            const toolResultMessage = message as ToolResultMessageType;
            const lastToolCallMessage =
                lastMessage && lastMessage.type === 'tool_call'
                    ? (lastMessage as ToolCallMessageType)
                    : undefined;
            return (
                <ToolResultMessage
                    key={toolResultMessage.id}
                    followsCall={
                        lastToolCallMessage &&
                        lastToolCallMessage.toolCallId ===
                            toolResultMessage.toolCallId
                    }
                    message={toolResultMessage}
                />
            );
        }

        default: // system or unknown type
            return <SystemMessage key={message.id} message={message} />;
    }
};

export default MessageList;
