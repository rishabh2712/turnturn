## ADDED Requirements

### Requirement: Transport-Safe Engine Protocol
turnturn SHALL define engine commands and events as serializable protocol messages.

#### Scenario: Command and event round trip through JSON
- **WHEN** a transport command or engine event is produced
- **THEN** it can be serialized to JSON and deserialized back without losing required fields
- **AND** it contains no functions, class instances, symbols, Dates, or provider-native objects.

#### Scenario: Renderer resumes a subscription
- **WHEN** a renderer reconnects with `afterEventId`
- **THEN** turnturn returns subsequent canonical events without requiring renderer access to engine internals.

### Requirement: In-Process v1 Transport
turnturn SHALL implement an in-process transport for v1 while keeping the protocol compatible with future remote transports.

#### Scenario: CLI submits a turn
- **WHEN** the CLI submits user input through the in-process transport
- **THEN** the engine receives a canonical command
- **AND** the CLI observes canonical engine events.

### Requirement: Protocol Before Engine Implementation
turnturn SHALL define protocol and event-log contracts before engine scaffolding depends on them.

#### Scenario: Engine work begins
- **WHEN** implementation begins for the agent engine
- **THEN** event identity, ordering, schema versioning, durable versus ephemeral classification, parent/causal IDs, approval commands, cancellation commands, and replay fixture expectations have been specified.

### Requirement: Tool Use Result Invariant
turnturn SHALL specify a tool-use/tool-result state machine before implementing tool execution.

#### Scenario: Tool call aborts or fails
- **WHEN** a model-requested tool call is denied, aborted, times out, or fails during execution
- **THEN** turnturn records a terminal tool result or explicitly records why no model-visible result can be produced.

### Requirement: App Session Facade
turnturn SHALL define app/session facade responsibilities without requiring a separate app server in v1.

#### Scenario: Approval response is submitted
- **WHEN** a renderer answers an approval request
- **THEN** the app/session facade routes the response to the owning session and approval request.

#### Scenario: v1 has only one local client
- **WHEN** v1 runs with only an in-process client
- **THEN** the app/session facade may be a module-level API rather than an HTTP or WebSocket server.

### Requirement: Executor Boundary
turnturn SHALL execute shell and filesystem side effects through executor interfaces rather than embedding process mechanics in the engine loop.

#### Scenario: Tool runs a shell command
- **WHEN** a shell tool is approved
- **THEN** the tool executor delegates process execution to a runtime executor with cwd, timeout, cancellation, and bounded output configuration.
