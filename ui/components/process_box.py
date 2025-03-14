"""
Process box components for MAGI UI.
"""
from textual.app import ComposeResult
from textual.containers import Container, Vertical
from textual.widgets import TextArea, RichLog, Markdown, Static
from textual.events import Key, MouseEvent
from rich.markdown import Markdown as RichMarkdown
from typing import Callable
import re

from ui.components.textarea import SubmittableTextArea


class ProcessBox(Container):
    """Widget to display a process with its own input."""
    CSS = """
    .process-box {
        height: 1fr;
        border: solid #FF6600;
        margin: 1;
        padding: 1;
        display: block;
        background: #000000;
    }
    
    .header {
        height: auto;
        padding: 0 1;
        background: #000000;
    }
    
    .process-id {
        color: #FF6600;
        background: #000000;
        font-weight: bold;
        border-bottom: solid #FF6600;
        width: 100%;
        padding: 0 1;
    }

    .process-output {
        height: 1fr;
        margin-bottom: 1;
        border: solid transparent;
        color: #FFFFFF;
        background: #000000;
        /* Enable text wrapping for long lines */
        overflow-wrap: normal;
        word-wrap: break-word;
    }
    
    /* Ensure code blocks wrap properly */
    .process-output pre {
        white-space: pre-wrap;
        word-wrap: break-word;
    }

    .process-input {
        height: auto;
        min-height: 1;
        max-height: 6;
        dock: bottom;
        border: solid #FF00FF;
        background: #000000;
        color: #FFFFFF;
    }

    .process-box:focus-within {
        border: solid #00FFFF;
    }

    Input:focus {
        border: solid #00FFFF;
    }

    TextArea:focus {
        border: solid #00FFFF;
    }

    RichLog:hover {
        border: dashed #FFFF00;
    }

    .process-input:hover {
        border: dashed #FFFF00;
    }
    """

    def __init__(self, process_id: str, content: str = "", on_input: Callable = None, **kwargs):
        super().__init__(**kwargs)
        self.process_id = process_id
        self.content = content
        self.on_input = on_input
        self.add_class("process-box")
        self.auto_scroll_enabled = True
        self.last_content_length = 0

    def _clean_code_blocks(self, content: str) -> str:
        """Process code blocks to remove the backtick markers but preserve the code."""
        # Replace ``` code blocks with something that won't trigger markdown formatting
        # but will still display the code properly
        
        # First replace triple backticks with a custom marker to avoid regex complexity
        content = content.replace("```", "CODEBLOCK_MARKER")
        
        # Extract code blocks with language specifier
        pattern = r'CODEBLOCK_MARKER(\w+)\s*\n(.*?)CODEBLOCK_MARKER'
        for match in re.finditer(pattern, content, re.DOTALL):
            language = match.group(1)
            code = match.group(2)
            replacement = f"[bold #AAAAAA]Code ({language}):[/]\n[#CCCCCC]{code}[/]"
            old_block = f"CODEBLOCK_MARKER{language}\n{code}CODEBLOCK_MARKER"
            content = content.replace(old_block, replacement)
        
        # Extract code blocks without language specifier
        pattern = r'CODEBLOCK_MARKER\s*\n(.*?)CODEBLOCK_MARKER'
        for match in re.finditer(pattern, content, re.DOTALL):
            code = match.group(1)
            replacement = f"[bold #AAAAAA]Code:[/]\n[#CCCCCC]{code}[/]"
            old_block = f"CODEBLOCK_MARKER\n{code}CODEBLOCK_MARKER"
            content = content.replace(old_block, replacement)
            
        return content
        
    def update_content(self, new_content: str):
        """Update the content of this process output."""
        output = self.query_one(RichLog)
        
        # Only update if content has changed
        if new_content != self.content:
            # Check if we have new content to append
            if len(new_content) > len(self.content) and new_content.startswith(self.content):
                # Append only the new part
                additional_content = new_content[len(self.content):]
                
                # Process and clean content for markdown rendering
                if "**" in additional_content or "__" in additional_content or "*" in additional_content or "```" in additional_content:
                    try:
                        # Clean code blocks first
                        if "```" in additional_content:
                            additional_content = self._clean_code_blocks(additional_content)
                            
                        # Convert markdown to Rich renderable
                        md = RichMarkdown(additional_content)
                        output.write(md)
                    except Exception:
                        # Fallback if markdown parsing fails
                        output.write(additional_content)
                else:
                    output.write(additional_content)
            else:
                # Full content replacement needed
                output.clear()
                
                # Process and clean content for markdown rendering
                if "**" in new_content or "__" in new_content or "*" in new_content or "```" in new_content:
                    try:
                        # Clean code blocks first
                        if "```" in new_content:
                            new_content = self._clean_code_blocks(new_content)
                            
                        # Convert markdown to Rich renderable
                        md = RichMarkdown(new_content)
                        output.write(md)
                    except Exception:
                        # Fallback if markdown parsing fails
                        output.write(new_content)
                else:
                    output.write(new_content)
            
            # Update stored content
            self.content = new_content
        
        # Set auto-scroll based on user preference
        output.auto_scroll = self.auto_scroll_enabled

    def compose(self) -> ComposeResult:
        # Add a header with the process ID
        header_text = Static(self.process_id, classes="process-id")
        yield header_text
        
        # Use RichLog instead of Static for better scrolling
        log = RichLog(classes="process-output", id=f"output-{self.process_id}")
        log.auto_scroll = True  # Enable auto-scrolling by default
        
        if self.content:
            # Check for markdown and render it
            if "**" in self.content or "__" in self.content or "*" in self.content or "```" in self.content:
                try:
                    # Clean code blocks first
                    cleaned_content = self.content
                    if "```" in self.content:
                        cleaned_content = self._clean_code_blocks(self.content)
                        
                    # Convert markdown to Rich renderable
                    md = RichMarkdown(cleaned_content)
                    log.write(md)
                except Exception:
                    log.write(self.content)
            else:
                log.write(self.content)
                
        yield log
        input_widget = SubmittableTextArea(classes="process-input", id=f"input-{self.process_id}")
        input_widget.can_focus = True  # Explicitly make it focusable
        # Enable formatting options
        input_widget.show_line_numbers = False
        input_widget.soft_wrap = True
        yield input_widget

    def on_submittable_text_area_submitted(self, event: SubmittableTextArea.Submitted):
        """Event handler for process-specific input submission."""
        if self.on_input:
            self.on_input(self.process_id, event.value)
        event.text_area.clear()
        # Note: Can't stop propagation with the current event system
        # Need a different approach to prevent duplicate handling

    def on_key(self, event: Key):
        """Handle key events for the text area."""
        # First check if the event is for a TextArea by checking
        # if it occurred within this container and we can find a TextArea
        text_area = self.query_one(TextArea)
        if not text_area.has_focus:
            return
        
        # The handling of Ctrl+Enter is done through key bindings and actions now
        # We only need to prevent the default behavior
        if event.key == "ctrl+enter":
            event.prevent_default()

    def on_click(self) -> None:
        """Focus this process's input when the box is clicked."""
        self.query_one(TextArea).focus()
    
    def on_mouse_scroll(self, event: MouseEvent) -> None:
        """Handle mouse scroll events."""
        # If user is scrolling up, disable auto-scrolling
        if event.y < 0:  # Scrolling up
            self.auto_scroll_enabled = False
        elif event.y > 0 and self.query_one(RichLog).is_at_end:  # Scrolling down and at end
            # Re-enable auto-scrolling when user scrolls to the bottom
            self.auto_scroll_enabled = True