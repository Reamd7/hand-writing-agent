/**
 * Top-level application component.
 *
 * Orchestrates agent state management and composes all child components.
 * This is the ink equivalent of pi's InteractiveMode class, but expressed
 * as a declarative React component tree instead of an imperative class
 * with manual Container/Component management.
 */

import React, { useCallback } from "react";
import { Box, useApp, useInput } from "ink";
import { useAgent, usePromptSubmit } from "../hooks/useAgent.js";
import type { AgentSession } from "../hooks/useAgent.js";
import { StatusBar } from "./StatusBar.js";
import { ChatHistory } from "./ChatHistory.js";
import { StreamingText } from "./StreamingText.js";
import { InputEditor } from "./InputEditor.js";

interface AppProps {
  agent: AgentSession;
}

export function App({ agent }: AppProps): React.ReactElement {
  const { messages, streamingContent, toolStates, isLoading } = useAgent(agent);
  const submitPrompt = usePromptSubmit(agent);
  const { exit } = useApp();

  // -----------------------------------------------------------------------
  // Global key handler.
  //
  // pi handles this via setupKeyHandlers() which registers SIGINT handlers
  // and editor escape callbacks. In ink, useInput is the equivalent.
  // -----------------------------------------------------------------------
  useInput((input, key) => {
    // Ctrl+C: abort if loading, exit if idle
    if (key.ctrl && input === "c") {
      if (isLoading) {
        agent.abort();
      } else {
        exit();
      }
    }
  });

  // -----------------------------------------------------------------------
  // Submit handler. Equivalent to pi's getUserInput() -> session.prompt() loop.
  // -----------------------------------------------------------------------
  const handleSubmit = useCallback(
    (text: string) => {
      submitPrompt(text);
    },
    [submitPrompt],
  );

  // -----------------------------------------------------------------------
  // Render tree.
  //
  // Compare with pi's init() which manually adds children to ui:
  //   ui.addChild(headerContainer)
  //   ui.addChild(chatContainer)
  //   ui.addChild(statusContainer)
  //   ui.addChild(editorContainer)
  //   ui.addChild(footer)
  //
  // In ink, we express the same hierarchy declaratively:
  // -----------------------------------------------------------------------
  return (
    <Box flexDirection="column" width="100%">
      <StatusBar modelName={agent.model.id} isLoading={isLoading} />

      <ChatHistory messages={messages} toolStates={toolStates} />

      {streamingContent !== null && <StreamingText content={streamingContent} />}

      <InputEditor onSubmit={handleSubmit} isActive={!isLoading} />
    </Box>
  );
}
