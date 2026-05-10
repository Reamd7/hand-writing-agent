/**
 * Demo: load both extensions and test interception patterns.
 *
 * This file demonstrates how extensions interact with the pi runtime.
 * It cannot be run standalone (extensions require the pi runtime), but
 * serves as a reference for understanding extension loading and event flow.
 *
 * To actually run these extensions:
 *   pi -e ./src/plan-extension.ts -e ./src/security-extension.ts
 *
 * Or via package.json discovery:
 *   # With pi.extensions configured in package.json, just run:
 *   pi
 */

// ---------------------------------------------------------------------------
// Extension loading flow (what pi does internally)
// ---------------------------------------------------------------------------

/**
 * 1. Discovery
 *    pi scans for extensions in this order:
 *    - Project: ./.agent/extensions/ (or ./.pi/extensions/)
 *    - Global:  ~/.agent/extensions/ (or ~/.pi/agent/extensions/)
 *    - Explicit: --extension / -e flags
 *    - Package:  package.json "pi.extensions" field
 *
 * 2. Loading
 *    Each extension file is loaded via jiti (runtime TypeScript transpilation).
 *    The default export function receives an ExtensionAPI instance.
 *
 * 3. Registration phase
 *    During the factory call, extensions register:
 *    - Event handlers via pi.on()
 *    - Commands via pi.registerCommand()
 *    - Tools via pi.registerTool()
 *    - Shortcuts via pi.registerShortcut()
 *    - Flags via pi.registerFlag()
 *
 * 4. Binding phase
 *    After all extensions load, the runner calls bindCore() which:
 *    - Replaces stub actions with real implementations
 *    - Flushes any queued provider registrations
 *    - Makes pi.sendMessage(), pi.exec(), etc. functional
 *
 * 5. Runtime phase
 *    Events flow through registered handlers in registration order.
 *    Multiple extensions can handle the same event (pipeline pattern).
 */

// ---------------------------------------------------------------------------
// Event flow examples
// ---------------------------------------------------------------------------

/**
 * Example 1: User types "rm -rf /tmp/old"
 *
 * Event pipeline:
 *   tool_call (security-extension)
 *     -> checks against DANGEROUS_PATTERNS
 *     -> "rm -rf" matches "recursive delete" rule
 *     -> returns { block: true, reason: "..." }
 *     -> tool execution is SKIPPED
 *     -> agent receives error: "Security: command blocked (recursive delete)"
 *
 * Note: The plan extension also has a tool_call handler, but since the
 * security extension blocks first, subsequent handlers are not called
 * for blocking decisions.
 */

/**
 * Example 2: Agent reads a .env file containing API_KEY=sk-live-abc123...
 *
 * Event pipeline:
 *   tool_call (security-extension)
 *     -> toolName is "read", not "bash"
 *     -> returns undefined (allow)
 *   [tool executes, reads file content]
 *   tool_result (security-extension)
 *     -> scans content for SENSITIVE_PATTERNS
 *     -> "API_KEY=sk-live-abc123..." matches "generic API key assignment"
 *     -> returns { content: [...modified...] } with "[REDACTED]"
 *     -> agent sees: "API_KEY=[REDACTED]"
 */

/**
 * Example 3: User types "/plan refactor auth module"
 *
 * Command pipeline:
 *   1. pi routes to plan-extension's command handler
 *   2. Handler sets planActive=true, planGoal="refactor auth module"
 *   3. Handler calls pi.sendUserMessage() to trigger agent turn
 *
 * Agent turn pipeline:
 *   before_agent_start (plan-extension)
 *     -> planActive && no steps yet
 *     -> returns { message: { customType: "plan-instruction", content: "...", display: false } }
 *     -> invisible instruction injected into context
 *
 *   [agent creates numbered plan]
 *
 *   turn_end (plan-extension)
 *     -> parses [DONE:N] markers (none yet, this is plan creation)
 *
 * Next turn (user says "execute step 1"):
 *   before_agent_start (plan-extension)
 *     -> planActive && steps exist
 *     -> returns progress context with remaining steps
 *
 *   context (plan-extension)
 *     -> strips duplicate plan-instruction messages
 *     -> keeps only the latest one
 */

/**
 * Example 4: Observe vs intercept
 *
 * Observe events (return value ignored):
 *   agent_start  -> security-extension logs "session started"
 *   agent_end    -> security-extension logs "session ended, N entries"
 *   turn_start   -> could track timing, count turns
 *   turn_end     -> plan-extension tracks [DONE:N] completion
 *
 * Intercept events (return value modifies behavior):
 *   tool_call    -> security-extension blocks dangerous commands
 *   tool_result  -> security-extension redacts sensitive output
 *   before_agent_start -> plan-extension injects context messages
 *   context      -> plan-extension filters stale messages
 */

// ---------------------------------------------------------------------------
// Testing strategies
// ---------------------------------------------------------------------------

/**
 * Unit testing extension logic:
 *
 * The core logic in each extension is pure functions that can be tested
 * independently of the pi runtime:
 *
 * - parsePlanSteps(text) -> PlanStep[]
 *   Test with various numbered list formats
 *
 * - DANGEROUS_PATTERNS regex matching
 *   Test each pattern against positive and negative cases
 *
 * - SENSITIVE_PATTERNS regex replacement
 *   Test each pattern produces correct redacted output
 *
 * Integration testing (with faux provider):
 *
 * The pi test harness (packages/coding-agent/test/suite/harness.ts)
 * supports loading extensions via the programmatic API:
 *
 *   const session = await createTestSession({
 *     extensions: [planExtension, securityExtension],
 *     fauxResponses: [...]
 *   });
 *
 * This lets you verify the full event pipeline without real LLM calls.
 */

export {};
