/**
 * AssistantMessage Component
 * Renders messages from the AI assistant
 */
import * as React from 'react';
import { ClientMessage } from '../../context/SocketContext';
import { parseMarkdown } from '../utils/MarkdownUtils';
import { getDeltaMessageContent } from '../utils/ProcessBoxUtils';

interface AssistantMessageProps {
    message: ClientMessage;
    rgb: string;
}

const AssistantMessage: React.FC<AssistantMessageProps> = ({ message, rgb }) => {
    // Add a special class for delta messages (streaming)
    const bubbleClass = message.isDelta
        ? "message-bubble assistant-bubble streaming"
        : "message-bubble assistant-bubble";

    // Get the content to display (handling delta messages)
    const displayContent = getDeltaMessageContent(message);

    return (
        <div className="message-group assistant-message" key={message.message_id || message.id}>
            <div className={bubbleClass}
                style={{color: `rgba(${rgb} / 1)`}}>
                <div dangerouslySetInnerHTML={parseMarkdown(displayContent)}/>
            </div>
        </div>
    );
};

export default AssistantMessage;
