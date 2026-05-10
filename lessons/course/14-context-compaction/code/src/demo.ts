/**
 * Demo: Simulate a long conversation and trigger context compaction.
 *
 * This demo:
 * 1. Builds a simulated conversation that exceeds the context window
 * 2. Checks if compaction is needed (threshold mode)
 * 3. Runs prepareCompaction() to find the cut point
 * 4. Calls compact() to generate a summary via LLM
 * 5. Rebuilds the message array with the compacted context
 *
 * Set OPENAI_API_KEY to run with real LLM summarization.
 * Without it, the demo runs with a mock summary to show the pipeline.
 */

import type { CoreMessage } from "ai";
import { estimateTokensChars4, estimateTotalTokens } from "./token-counter.js";
import {
  shouldCompact,
  prepareCompaction,
  compact,
  rebuildMessages,
  type CompactionSettings,
  type CompactionPreparation,
} from "./compaction.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Simulated context window (small for demo purposes) */
const CONTEXT_WINDOW = 8000;

/** Compaction settings tuned for the small demo window */
const DEMO_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 2000,
  keepRecentTokens: 3000,
};

// ---------------------------------------------------------------------------
// Simulate a conversation
// ---------------------------------------------------------------------------

function buildSimulatedConversation(): CoreMessage[] {
  const messages: CoreMessage[] = [];

  // System-level context (in a real agent, this would be a system message)
  messages.push({
    role: "user",
    content:
      "You are a coding assistant. Help me build a web application with React and TypeScript.",
  });

  messages.push({
    role: "assistant",
    content:
      "I'll help you build a React + TypeScript web application. Let me start by understanding your requirements. What kind of application are you building?",
  });

  // Turn 1: Project setup
  messages.push({
    role: "user",
    content:
      "I want to build a task management app. It should have a dashboard with task lists, the ability to create/edit/delete tasks, and drag-and-drop reordering.",
  });

  messages.push({
    role: "assistant",
    content: [
      {
        type: "text",
        text: "Great, let me set up the project structure. I'll use Vite for the build tool and install the necessary dependencies.",
      },
      {
        type: "tool-call",
        toolCallId: "tc1",
        toolName: "write",
        args: {
          path: "package.json",
          content:
            '{"name":"task-manager","dependencies":{"react":"^18.3.0","react-dom":"^18.3.0","@dnd-kit/core":"^6.0.0"}}',
        },
      },
    ],
  });

  messages.push({
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "tc1",
        toolName: "write",
        result: "File written: package.json",
      },
    ],
  });

  // Turn 2: Component creation
  messages.push({
    role: "user",
    content: "Now create the main App component and the TaskList component.",
  });

  messages.push({
    role: "assistant",
    content: [
      {
        type: "text",
        text: "I'll create the App component with routing and the TaskList component with drag-and-drop support.",
      },
      {
        type: "tool-call",
        toolCallId: "tc2",
        toolName: "write",
        args: {
          path: "src/App.tsx",
          content: `import React from 'react';
import { TaskList } from './components/TaskList';
import { TaskProvider } from './context/TaskContext';

export function App() {
  return (
    <TaskProvider>
      <div className="app">
        <header><h1>Task Manager</h1></header>
        <main><TaskList /></main>
      </div>
    </TaskProvider>
  );
}`,
        },
      },
    ],
  });

  messages.push({
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "tc2",
        toolName: "write",
        result: "File written: src/App.tsx",
      },
    ],
  });

  messages.push({
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: "tc3",
        toolName: "write",
        args: {
          path: "src/components/TaskList.tsx",
          content: `import React from 'react';
import { DndContext, closestCenter } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useTaskContext } from '../context/TaskContext';
import { TaskItem } from './TaskItem';

export function TaskList() {
  const { tasks, reorderTasks } = useTaskContext();

  function handleDragEnd(event: any) {
    const { active, over } = event;
    if (active.id !== over?.id) {
      reorderTasks(active.id, over.id);
    }
  }

  return (
    <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={tasks} strategy={verticalListSortingStrategy}>
        {tasks.map(task => <TaskItem key={task.id} task={task} />)}
      </SortableContext>
    </DndContext>
  );
}`,
        },
      },
    ],
  });

  messages.push({
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "tc3",
        toolName: "write",
        result: "File written: src/components/TaskList.tsx",
      },
    ],
  });

  // Turn 3: Bug fix
  messages.push({
    role: "user",
    content:
      "There's a TypeScript error in TaskList.tsx - the useTaskContext hook doesn't exist yet. Also, TaskItem is missing. Can you fix both?",
  });

  messages.push({
    role: "assistant",
    content: [
      {
        type: "text",
        text: "You're right, let me create the TaskContext and TaskItem components.",
      },
      {
        type: "tool-call",
        toolCallId: "tc4",
        toolName: "read",
        args: { path: "src/components/TaskList.tsx" },
      },
    ],
  });

  messages.push({
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "tc4",
        toolName: "read",
        result:
          "import React from 'react';\nimport { DndContext, closestCenter } from '@dnd-kit/core';\n// ... (full file content)",
      },
    ],
  });

  messages.push({
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: "tc5",
        toolName: "write",
        args: {
          path: "src/context/TaskContext.tsx",
          content: `import React, { createContext, useContext, useState, type ReactNode } from 'react';

interface Task { id: string; title: string; done: boolean; }
interface TaskContextType {
  tasks: Task[];
  addTask: (title: string) => void;
  toggleTask: (id: string) => void;
  deleteTask: (id: string) => void;
  reorderTasks: (activeId: string, overId: string) => void;
}

const TaskContext = createContext<TaskContextType | null>(null);

export function useTaskContext() {
  const ctx = useContext(TaskContext);
  if (!ctx) throw new Error('useTaskContext must be used within TaskProvider');
  return ctx;
}

export function TaskProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<Task[]>([
    { id: '1', title: 'Set up project', done: true },
    { id: '2', title: 'Create components', done: false },
    { id: '3', title: 'Add drag and drop', done: false },
  ]);

  // ... implementation
  return <TaskContext.Provider value={{ tasks, addTask: () => {}, toggleTask: () => {}, deleteTask: () => {}, reorderTasks: () => {} }}>{children}</TaskContext.Provider>;
}`,
        },
      },
    ],
  });

  messages.push({
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "tc5",
        toolName: "write",
        result: "File written: src/context/TaskContext.tsx",
      },
    ],
  });

  messages.push({
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: "tc6",
        toolName: "write",
        args: {
          path: "src/components/TaskItem.tsx",
          content: `import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

interface Task { id: string; title: string; done: boolean; }

export function TaskItem({ task }: { task: Task }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: task.id });
  const style = { transform: CSS.Transform.toString(transform), transition };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners} className="task-item">
      <span className={task.done ? 'done' : ''}>{task.title}</span>
    </div>
  );
}`,
        },
      },
    ],
  });

  messages.push({
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "tc6",
        toolName: "write",
        result: "File written: src/components/TaskItem.tsx",
      },
    ],
  });

  messages.push({
    role: "assistant",
    content:
      "I've created all the missing files:\n\n1. `src/context/TaskContext.tsx` - Task state management with React Context\n2. `src/components/TaskItem.tsx` - Individual task component with drag-and-drop support\n\nThe TypeScript errors should be resolved now. The TaskContext provides the task state and operations (add, toggle, delete, reorder) to all components via the `useTaskContext` hook.",
  });

  // Turn 4: Styling discussion (more context)
  messages.push({
    role: "user",
    content:
      "Can you add CSS modules for styling? I want a clean, modern look with a card-based layout for each task.",
  });

  messages.push({
    role: "assistant",
    content: [
      {
        type: "text",
        text: "I'll add CSS modules for a modern card-based design. Let me create styles for the app, task list, and task items.",
      },
      {
        type: "tool-call",
        toolCallId: "tc7",
        toolName: "write",
        args: {
          path: "src/styles/TaskItem.module.css",
          content: `.card { background: white; border-radius: 12px; padding: 16px 20px; margin-bottom: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.12); display: flex; align-items: center; gap: 12px; cursor: grab; transition: box-shadow 0.2s, transform 0.2s; }
.card:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
.card.dragging { box-shadow: 0 8px 24px rgba(0,0,0,0.2); transform: scale(1.02); }
.title { flex: 1; font-size: 14px; color: #1a1a1a; }
.title.done { text-decoration: line-through; color: #999; }
.checkbox { width: 20px; height: 20px; border-radius: 50%; border: 2px solid #ddd; cursor: pointer; }
.deleteBtn { opacity: 0; color: #ff4444; cursor: pointer; transition: opacity 0.2s; }
.card:hover .deleteBtn { opacity: 1; }`,
        },
      },
    ],
  });

  messages.push({
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "tc7",
        toolName: "write",
        result: "File written: src/styles/TaskItem.module.css",
      },
    ],
  });

  messages.push({
    role: "assistant",
    content:
      "I've created the CSS module with a modern card-based design. Each task card has hover effects, smooth drag animations, and a delete button that appears on hover. The overall look is clean and minimal.",
  });

  return messages;
}

// ---------------------------------------------------------------------------
// Main demo
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Lesson 14: Context Compaction Demo ===\n");

  // Step 1: Build a simulated conversation
  const messages = buildSimulatedConversation();
  const totalTokens = estimateTotalTokens(messages);

  console.log(`Conversation: ${messages.length} messages`);
  console.log(`Estimated tokens: ${totalTokens}`);
  console.log(`Context window: ${CONTEXT_WINDOW}`);
  console.log(`Reserve tokens: ${DEMO_SETTINGS.reserveTokens}`);
  console.log(`Effective limit: ${CONTEXT_WINDOW - DEMO_SETTINGS.reserveTokens}`);
  console.log();

  // Step 2: Per-message token breakdown
  console.log("--- Per-message token estimates ---");
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const tokens = estimateTokensChars4(msg);
    const preview =
      typeof msg.content === "string"
        ? msg.content.slice(0, 60)
        : Array.isArray(msg.content)
          ? msg.content
              .map((p) => {
                if ("text" in p) return (p as { text: string }).text.slice(0, 40);
                if ("toolName" in p) return `${(p as { toolName: string }).toolName}(...)`;
                if ("result" in p) return "[result]";
                return "?";
              })
              .join(" | ")
          : "?";
    console.log(
      `  [${i}] ${msg.role.padEnd(10)} ${String(tokens).padStart(5)} tokens  ${preview}...`,
    );
  }
  console.log();

  // Step 3: Check if compaction is needed
  const needsCompaction = shouldCompact(totalTokens, CONTEXT_WINDOW, DEMO_SETTINGS);
  console.log(
    `Should compact? ${needsCompaction ? "YES" : "NO"} (${totalTokens} > ${CONTEXT_WINDOW - DEMO_SETTINGS.reserveTokens})`,
  );
  console.log();

  if (!needsCompaction) {
    console.log("No compaction needed. Try reducing CONTEXT_WINDOW to trigger compaction.");
    return;
  }

  // Step 4: Prepare compaction
  console.log("--- Preparing compaction ---");
  const preparation = prepareCompaction(messages, DEMO_SETTINGS);

  if (!preparation) {
    console.log("Cannot prepare compaction (not enough messages).");
    return;
  }

  console.log(`Cut point: message index ${preparation.firstKeptIndex}`);
  console.log(`Messages to summarize: ${preparation.messagesToSummarize.length}`);
  console.log(`Messages to keep: ${preparation.messagesToKeep.length}`);
  console.log(`Read files: ${preparation.readFiles.join(", ") || "(none)"}`);
  console.log(`Modified files: ${preparation.modifiedFiles.join(", ") || "(none)"}`);
  console.log();

  // Step 5: Run compaction (LLM call or mock)
  const hasApiKey = !!process.env.OPENAI_API_KEY;

  if (hasApiKey) {
    console.log("--- Running compaction (calling LLM) ---");
    try {
      const result = await compact(preparation, "gpt-4o-mini");
      console.log(`\nCompaction result:`);
      console.log(`  Tokens before: ${result.tokensBefore}`);
      console.log(`  Tokens after:  ${result.tokensAfter}`);
      console.log(
        `  Reduction:     ${Math.round((1 - result.tokensAfter / result.tokensBefore) * 100)}%`,
      );
      console.log(`\nGenerated summary:\n`);
      console.log(result.summary);
      console.log();

      // Rebuild messages
      const newMessages = rebuildMessages(result.summary, preparation.messagesToKeep);
      console.log(`\n--- After compaction ---`);
      console.log(`Messages: ${messages.length} -> ${newMessages.length}`);
      console.log(`Tokens: ${result.tokensBefore} -> ${result.tokensAfter}`);
    } catch (err) {
      console.error("LLM call failed:", err);
      console.log("\nFalling back to mock summary...");
      runMockCompaction(preparation);
    }
  } else {
    console.log("--- Running compaction (mock - set OPENAI_API_KEY for real LLM) ---");
    runMockCompaction(preparation);
  }
}

function runMockCompaction(preparation: CompactionPreparation) {
  const mockSummary = `## Goal
Build a task management web app with React + TypeScript, featuring task lists, CRUD operations, and drag-and-drop reordering.

## Progress
### Done
- [x] Project setup with Vite, React 18, @dnd-kit
- [x] App component with TaskProvider context
- [x] TaskList with DndContext and SortableContext
- [x] TaskContext with state management (add, toggle, delete, reorder)
- [x] TaskItem component with useSortable hook
- [x] CSS modules with modern card-based design

### In Progress
- [ ] Task creation/editing UI

## Key Decisions
- **@dnd-kit over react-beautiful-dnd**: Better TypeScript support and active maintenance
- **React Context over Redux**: Sufficient for this scale, less boilerplate

## Next Steps
1. Implement task creation form
2. Add task editing (inline or modal)
3. Add persistence (localStorage or API)`;

  const fullSummary =
    mockSummary + formatFileOpsForDemo(preparation.readFiles, preparation.modifiedFiles);

  const newMessages = rebuildMessages(fullSummary, preparation.messagesToKeep);
  const tokensAfter = estimateTotalTokens(newMessages);

  console.log(`\nMock compaction result:`);
  console.log(`  Tokens before: ${preparation.tokensBefore}`);
  console.log(`  Tokens after:  ${tokensAfter}`);
  console.log(
    `  Reduction:     ${Math.round((1 - tokensAfter / preparation.tokensBefore) * 100)}%`,
  );
  console.log(`\nMock summary:\n`);
  console.log(fullSummary);
  console.log(`\n--- After compaction ---`);
  console.log(
    `Messages: ${preparation.messagesToSummarize.length + preparation.messagesToKeep.length} -> ${newMessages.length}`,
  );
  console.log(`Tokens: ${preparation.tokensBefore} -> ${tokensAfter}`);
}

function formatFileOpsForDemo(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = [];
  if (readFiles.length > 0) {
    sections.push(`\n\n<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  }
  if (modifiedFiles.length > 0) {
    sections.push(`\n\n<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  }
  return sections.join("");
}

// ---------------------------------------------------------------------------

main().catch(console.error);
