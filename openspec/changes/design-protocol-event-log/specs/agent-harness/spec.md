## ADDED Requirements

### Requirement: Canonical Command Envelope
turnturn SHALL define a JSON-serializable command envelope for all client, app, session, approval, and cancellation intents.

#### Scenario: Command crosses transport boundary
- **WHEN** a command is sent into the engine boundary
- **THEN** it contains a schema version, command ID, command type, timestamp, relevant scope IDs, and payload
- **AND** it can round-trip through JSON without provider-native objects or callbacks.

### Requirement: Durable Record Envelope
turnturn SHALL define a JSON-serializable durable record envelope for append-only recovery and replay facts.

#### Scenario: Durable record is appended
- **WHEN** the engine appends a durable record
- **THEN** it contains schema version, record ID, writer-assigned sequence, record type, timestamp, relevant scope IDs, and payload
- **AND** sequence is the only durable replay ordering authority.

### Requirement: Live Event Envelope
turnturn SHALL define a JSON-serializable live event envelope for renderer and subscriber progress.

#### Scenario: Live event is emitted
- **WHEN** the engine emits a live event
- **THEN** the event may reference a durable record or semantic ID
- **AND** it does not consume durable sequence numbers
- **AND** durable replay does not depend on receiving it.

### Requirement: Durable Versus Ephemeral Events
turnturn SHALL separate durable records from ephemeral live events.

#### Scenario: Replay runs
- **WHEN** model-visible history is replayed
- **THEN** replay depends only on durable records
- **AND** live progress events are not required.

### Requirement: Tool-Use Tool-Result Invariant
turnturn SHALL ensure every durable model-requested tool use reaches exactly one terminal result state or records why no model-visible result can be produced.

#### Scenario: Tool is denied
- **WHEN** a tool request is denied by policy or approval
- **THEN** turnturn records a terminal tool result state that can be replayed.

#### Scenario: Tool is aborted after request persistence
- **WHEN** cancellation occurs after a tool request is persisted
- **THEN** turnturn records an aborted terminal result if a model-visible result can safely be produced.

### Requirement: Approval Resolution
turnturn SHALL model approvals as serializable requests and responses.

#### Scenario: Approval is answered twice
- **WHEN** an approval has already resolved
- **AND** another response arrives for the same approval ID
- **THEN** the second response does not change the approved tool execution state
- **AND** it does not append another durable approval resolution.

### Requirement: Cancellation Race Precedence
turnturn SHALL define deterministic precedence between approval, cancellation, and terminal tool results.

#### Scenario: Cancellation wins before approval
- **WHEN** cancellation is accepted before approval resolution
- **THEN** the tool reaches an aborted terminal result
- **AND** later approval resolution for that tool is ignored.

#### Scenario: Tool already terminal
- **WHEN** a tool has a durable terminal result
- **THEN** later approval or cancellation commands cannot change that terminal state.

### Requirement: Separate Replay Projections
turnturn SHALL define provider-history replay separately from engine-state replay.

#### Scenario: Provider history is reconstructed
- **WHEN** durable records are replayed for provider input
- **THEN** turnturn reconstructs only model-visible user input, assistant output, tool requests, and tool results.

#### Scenario: Engine state is reconstructed
- **WHEN** durable records are replayed for engine recovery
- **THEN** turnturn reconstructs current turn, tool, and approval state
- **AND** detects incomplete invalid transitions.

### Requirement: Replay Fixture Before Engine Work
turnturn SHALL define at least one replay fixture before engine implementation depends on the protocol.

#### Scenario: Completed turn fixture is replayed
- **WHEN** the fixture is loaded
- **THEN** turnturn reconstructs model-visible user input, assistant content, tool request, tool result, and final turn state in deterministic order.

#### Scenario: Multiple tool calls in one provider step are replayed
- **WHEN** a fixture contains multiple tool calls emitted in one provider step
- **THEN** turnturn preserves provider order while v1 executes them sequentially.
