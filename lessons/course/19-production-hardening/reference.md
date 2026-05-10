# Lesson 19: Production Hardening - Reference Material

## Pi Source Reference

### Config System (`packages/coding-agent/src/config.ts`)

Pi's config system demonstrates a layered approach to agent configuration:

- **Package-level config**: Read from `package.json` under the `piConfig` key. Determines app name, config directory name, version.
- **User-level config**: Stored in `~/.pi/agent/` (e.g., `settings.json`, `auth.json`, `models.json`). Loaded via `getAgentDir()` with environment variable override (`PI_CODING_AGENT_DIR`).
- **Path expansion**: `expandTildePath()` handles `~` and `~/` prefixes, mapping them to the user's home directory.
- **Environment variable overrides**: Multiple paths (`PI_PACKAGE_DIR`, `PI_SHARE_VIEWER_URL`, etc.) can be overridden via env vars.

Key pattern: Config values cascade from package defaults -> global user settings -> project-level settings -> environment overrides.

### Error Handling Patterns

#### Retry with Exponential Backoff (`packages/coding-agent/src/core/agent-session.ts`)

Pi implements auto-retry for transient errors (rate limits, 5xx, network failures):

```
Settings:
  enabled: boolean (default true)
  maxRetries: number (default 3)
  baseDelayMs: number (default 2000)

Delay formula: baseDelayMs * 2^(attempt - 1)
  Attempt 1: 2000ms
  Attempt 2: 4000ms
  Attempt 3: 8000ms
```

The `_isRetryableError()` method classifies errors using regex matching against known patterns:

- `overloaded`, `rate_limit`, `429`, `500-504`
- `connection_error`, `connection_refused`, `fetch failed`
- `timeout`, `socket hang up`, `terminated`

Context overflow errors are explicitly excluded from retry - they are handled by compaction instead.

The `_handleRetryableError()` method:

1. Checks if retry is enabled and under max attempts
2. Calculates delay with exponential backoff
3. Emits `auto_retry_start` event (UI shows countdown)
4. Removes error message from agent state
5. Sleeps with an abortable signal (user can cancel)
6. Retries via `agent.continue()`

#### Context Overflow Recovery

When the LLM returns a context overflow error:

1. Detected by `isContextOverflow()` - checks error message and token counts against `model.contextWindow`
2. If not already attempted recovery, sets `_overflowRecoveryAttempted = true`
3. Runs auto-compaction with `reason: "overflow"` and `willRetry: true`
4. After compaction, automatically retries the request
5. If recovery fails again, shows error: "Context overflow recovery failed after one compact-and-retry attempt"

#### Tool Execution Error Handling (`packages/coding-agent/src/core/tools/bash.ts`)

The bash tool demonstrates graceful error handling:

- Timeout: Kills entire process tree, throws descriptive error with timeout duration
- Abort: Kills process tree on signal, throws "Command aborted"
- Non-zero exit: Includes full output in error message with exit code
- Output truncation: Persists full output to temp file, returns truncated version with pointer to full output

### Settings Manager (`packages/coding-agent/src/core/settings-manager.ts`)

Settings follow a merge hierarchy:

1. **Default values** (hardcoded in getters, e.g., `this.settings.retry?.enabled ?? true`)
2. **Global settings** (`~/.pi/agent/settings.json`)
3. **Project settings** (`.pi/settings.json` in project root)

Each section has typed interfaces: `CompactionSettings`, `RetrySettings`, `ProviderRetrySettings`, `TerminalSettings`, etc.

### Path Safety (`packages/coding-agent/src/core/tools/path-utils.ts`)

Pi resolves user-provided paths safely:

- `expandPath()`: Handles `~`, `~/`, Unicode space normalization, `@` prefix removal
- `resolveToCwd()`: Resolves relative paths against a known CWD
- `resolveReadPath()`: Tries multiple platform-specific variants (macOS NFD, curly quotes, AM/PM spaces)

All paths are resolved to absolute form before file operations - there is no raw concatenation of user input.

---

## OWASP Path Traversal Prevention

Reference: [OWASP Path Traversal](https://owasp.org/www-community/attacks/Path_Traversal)

### The Attack

Path traversal (directory traversal) exploits insufficient input validation to access files outside intended directories. An attacker supplies input like `../../etc/passwd` or uses encoding tricks to escape the allowed directory.

### Common Attack Vectors

```
Direct traversal:      ../../../etc/passwd
URL encoding:          ..%2F..%2F..%2Fetc%2Fpasswd
Double encoding:       ..%252F..%252F..%252Fetc%252Fpasswd
Null byte injection:   ../../../etc/passwd%00.png
Unicode/UTF-8:         ..%c0%af..%c0%af
Windows-specific:      ..\..\..\windows\system32\config\sam
```

### Prevention Checklist

1. **Resolve to absolute path** before any comparison:
   ```
   realPath = fs.realpathSync(resolve(userInput))
   ```
2. **Validate prefix** - the resolved path must start with the allowed base directory:
   ```
   if (!realPath.startsWith(allowedBase + sep)) reject()
   ```
3. **Reject null bytes** - strip or reject `\0` in input
4. **Normalize separators** - handle both `/` and `\` on Windows
5. **Use allowlists** over blocklists when possible
6. **Avoid constructing paths from user input** - use IDs or indices to map to files
7. **Run with least privilege** - limit filesystem access at the OS level

### Key Principle

Never trust user-supplied file paths. Always:

```
resolve -> realpath -> validate prefix -> operate
```

---

## Exponential Backoff Pattern

### Core Algorithm

```
delay = min(baseDelay * 2^attempt, maxDelay)
```

With jitter (recommended for distributed systems):

```
delay = min(baseDelay * 2^attempt, maxDelay) * random(0.5, 1.5)
```

### Why Exponential Backoff

- **Linear retry** (fixed delay) causes thundering herd when many clients retry simultaneously
- **Exponential backoff** spreads retries over time, reducing server load during outages
- **Jitter** further decorrelates retries from multiple clients

### Retry Classification

Not all errors should be retried:

| Error Type                | Retry? | Reason                      |
| ------------------------- | ------ | --------------------------- |
| 429 Too Many Requests     | Yes    | Rate limit, will clear      |
| 500 Internal Server Error | Yes    | Transient server issue      |
| 502 Bad Gateway           | Yes    | Upstream issue              |
| 503 Service Unavailable   | Yes    | Temporary overload          |
| 504 Gateway Timeout       | Yes    | Timeout, may succeed        |
| 400 Bad Request           | No     | Client error, won't change  |
| 401 Unauthorized          | No     | Auth issue, needs fix       |
| 403 Forbidden             | No     | Permission issue            |
| 404 Not Found             | No     | Resource missing            |
| Context Overflow          | No     | Needs compaction, not retry |

### Implementation Considerations

1. **Max retries**: Cap attempts (typically 3-5) to prevent infinite loops
2. **Max delay**: Cap delay (typically 30-60s) to prevent excessively long waits
3. **Abort support**: Allow cancellation during the sleep period
4. **Idempotency**: Only retry operations that are safe to repeat
5. **State cleanup**: Remove failed state before retrying (e.g., Pi removes the error message from agent state)
6. **Circuit breaker**: After repeated failures, stop retrying and fail fast

### Pi's Implementation

```
baseDelayMs = 2000
maxRetries = 3

Attempt 1: wait 2000ms  (2s)
Attempt 2: wait 4000ms  (4s)
Attempt 3: wait 8000ms  (8s)
Total max wait: 14s before final failure
```

Pi's approach is notable for:

- **Abortable waits**: User can press Escape to cancel retry
- **UI feedback**: Shows countdown timer during retry wait
- **Error classification**: Distinguishes retryable (network/rate limit) from non-retryable (overflow/auth)
- **Separate handling paths**: Context overflow goes to compaction, not retry
