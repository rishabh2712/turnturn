## ADDED Requirements

### Requirement: Engine and Renderer Separation
turnturn SHALL keep the agent engine independent from UI renderers.

#### Scenario: Renderer subscribes to a turn
- **WHEN** a renderer starts observing a running turn
- **THEN** it receives canonical events
- **AND** it does not need to import private engine state.

### Requirement: Canonical Provider Boundary
turnturn SHALL use provider-neutral canonical messages and events internally.

#### Scenario: Provider adapter sends a request
- **WHEN** the engine starts a provider step
- **THEN** the provider adapter transforms canonical messages into provider-specific payloads
- **AND** provider stream output is transformed back into canonical events before persistence.

### Requirement: Agent Loop
turnturn SHALL run an agent loop that alternates provider steps and tool execution until a terminal turn state is reached.

#### Scenario: Model requests a tool
- **WHEN** a provider response contains a tool call
- **THEN** the engine evaluates policy, executes or rejects the call, records the lifecycle, and sends the resulting tool output into a later provider step.

### Requirement: Tool Policy Gate
turnturn SHALL evaluate a policy decision before executing a tool.

#### Scenario: Tool requires approval
- **WHEN** a tool invocation requires approval
- **THEN** the engine emits an approval request event
- **AND** execution waits for allow, deny, abort, or modified-input decision.

### Requirement: Localized Tool Failure
turnturn SHALL keep recoverable tool failures local to the tool call.

#### Scenario: One tool fails beside another
- **WHEN** sibling tool calls are executing
- **AND** one tool fails or is denied
- **THEN** the sibling tool call result remains intact
- **AND** the turn may continue with structured results.

### Requirement: Durable Sessions
turnturn SHALL persist conversation, session, turn, provider, tool, approval, and error events in a provider-neutral format.

#### Scenario: Process restarts
- **WHEN** a conversation is resumed after process restart
- **THEN** the engine hydrates state from persisted canonical events
- **AND** replay can reconstruct model-visible history deterministically.

### Requirement: Sequential Then Parallel Tool Execution
turnturn SHALL start with sequential tool execution and later support explicit parallel-safe waves.

#### Scenario: Parallel wave completes out of order
- **WHEN** parallel-safe tool calls complete in a different order from request order
- **THEN** turnturn groups returned results in original call order before the next provider step.

### Requirement: Turn Observability
turnturn SHALL emit traceable lifecycle events for every major turn operation.

#### Scenario: Debugging a turn
- **WHEN** a developer inspects a turn timeline
- **THEN** they can see user input, provider requests, tool calls, approvals, errors, persistence writes, and final output with correlated IDs.

### Requirement: Memory and Subagent Boundaries
turnturn SHALL define memory and subagent interfaces without coupling them to raw renderer state.

#### Scenario: Subagent completes work
- **WHEN** a subagent completes
- **THEN** the parent conversation receives a summarized result and linked artifacts
- **AND** raw child internals remain isolated unless explicitly requested.

