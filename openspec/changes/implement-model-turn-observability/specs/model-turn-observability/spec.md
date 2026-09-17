## Purpose

Make one model turn explainable end to end: what context Turnturn selected, what provider request it sent, what response it received and normalized, what tools ran, and which runtime results became model-visible later.

## ADDED Requirements

### Requirement: Diagnostic traces do not define conversation state

Turnturn SHALL store model-turn traces separately from durable session records, and trace availability or failure SHALL NOT affect engine behavior or conversation replay.

#### Scenario: Trace writing fails during a turn

- **GIVEN** tracing is enabled
- **WHEN** the trace writer fails while a turn is running
- **THEN** the engine SHALL continue the turn
- **AND** the turn SHALL still reach the same durable terminal state it would reach with tracing disabled
- **AND** the trace degradation SHALL be diagnosable

#### Scenario: Trace data is deleted

- **GIVEN** a conversation with durable records and trace bundles
- **WHEN** its trace bundles are deleted
- **THEN** durable engine replay SHALL be unchanged
- **AND** provider-history replay SHALL be unchanged

### Requirement: Every concrete provider attempt is identifiable

Turnturn SHALL represent every concrete upstream provider request as a distinct attempt correlated to its conversation, session, turn, and provider step.

#### Scenario: A provider request is retried

- **GIVEN** the first upstream request fails before completion
- **WHEN** the same provider step retries and succeeds
- **THEN** the trace SHALL contain two attempts with different identities
- **AND** each attempt SHALL retain its own request, timing, and terminal outcome

#### Scenario: An attempt receives competing terminal observations

- **WHEN** completion, failure, or cancellation is observed after the attempt already became terminal
- **THEN** the attempt SHALL retain its first terminal outcome
- **AND** the duplicate terminal observation SHALL be reported as a trace issue

### Requirement: Semantic context and provider wire request are both inspectable

For each provider attempt, Turnturn SHALL preserve the provider-neutral semantic input and the exact serialized provider request body as separate evidence.

#### Scenario: Tools are offered to a model

- **GIVEN** the tool executor exposes tool definitions
- **WHEN** a provider attempt is made
- **THEN** the semantic context SHALL list the offered tools
- **AND** the wire request SHALL show their provider-specific serialization
- **AND** an operator SHALL be able to determine whether any definition was lost during translation

#### Scenario: Context category is unavailable

- **GIVEN** memory or workspace instructions are not wired
- **WHEN** context is inspected
- **THEN** that category SHALL appear as empty or unavailable with a reason
- **AND** it SHALL NOT be silently omitted

#### Scenario: Transport credentials are configured

- **WHEN** a provider request is traced
- **THEN** the exact request body SHALL be preserved
- **BUT** Authorization, cookies, API keys, OAuth credentials, and arbitrary configured headers SHALL NOT enter trace storage

### Requirement: Provider stream translation is traceable

Turnturn SHALL preserve enough ordered raw and normalized response evidence to explain how provider stream input became `ProviderEvent` output.

#### Scenario: A tool call arrives in argument deltas

- **GIVEN** a provider stream containing incremental tool-call arguments
- **WHEN** the adapter assembles the call
- **THEN** the trace SHALL show the raw frames in arrival order
- **AND** the normalized start, argument-delta, and completion events they produced

#### Scenario: The raw response exceeds its capture bound

- **WHEN** raw provider response evidence exceeds the configured bound
- **THEN** capture SHALL become truncated without affecting provider processing
- **AND** the trace SHALL state that it is truncated and at what bound
- **AND** semantic terminal outcome and usage SHALL still be recorded

#### Scenario: Provider translation fails

- **WHEN** a raw frame violates the adapter's wire grammar
- **THEN** the trace SHALL retain the offending evidence when within the capture bound
- **AND** the normalized attempt outcome SHALL identify a protocol failure

### Requirement: Runtime output is not presumed model-visible

Turnturn SHALL distinguish runtime production of tool output from inclusion of that output in a later provider request.

#### Scenario: A tool completes before the turn is cancelled

- **WHEN** a tool produces a result but no later provider request includes it
- **THEN** the trace SHALL show the runtime result
- **AND** SHALL NOT claim that the model saw it

#### Scenario: A later provider step consumes a tool result

- **GIVEN** a completed tool result
- **WHEN** a later provider request includes the corresponding tool-result history item
- **THEN** the trace SHALL link that request to the runtime result
- **AND** the inspector SHALL show that the result became model-visible in that attempt

### Requirement: Context usage is explained semantically

Turnturn SHALL project context into non-overlapping named contributions and distinguish estimated category usage from authoritative provider usage.

#### Scenario: A completed attempt reports usage

- **WHEN** a provider returns input and output token usage
- **THEN** the inspector SHALL show those provider values as authoritative
- **AND** SHALL show local category counts as estimates
- **AND** tool interactions SHALL NOT also be counted as ordinary history

### Requirement: Trace retrieval is scoped and read-only

Turnturn SHALL expose traces only through conversation- and session-scoped read operations, and trace inspection SHALL NOT gain command submission capability.

#### Scenario: A trace is requested through another session

- **GIVEN** a valid trace ID belonging to session A
- **WHEN** it is requested through session B's path
- **THEN** the server SHALL return not found
- **AND** no trace metadata or payload SHALL be disclosed

#### Scenario: A large payload is not opened

- **WHEN** an operator requests a reduced trace summary
- **THEN** large raw payloads SHALL remain behind references
- **AND** SHALL be loaded only by a separate explicit request

### Requirement: The normal chat remains a product surface

Turnturn SHALL expose model-turn diagnostics on demand and SHALL NOT place raw provider detail in the normal transcript.

#### Scenario: Developer inspection is closed

- **WHEN** a conversation is displayed normally
- **THEN** raw frames, trace sequences, payload IDs, and provider JSON SHALL NOT appear
- **AND** assistant messages, tool activity, approvals, and turn state SHALL remain usable without trace data

#### Scenario: A turn is inspected

- **WHEN** an operator opens diagnostics for a turn
- **THEN** Context, Request, Response, Tools, and Runtime views SHALL be available
- **AND** each view SHALL stay scoped to the selected turn and attempt

#### Scenario: The assistant contradicts the request evidence

- **GIVEN** the exact request contains tool definitions
- **AND** the assistant claims that no tools are connected
- **WHEN** the turn is inspected
- **THEN** the Context and Request views SHALL prove that tools were sent
- **AND** the assistant claim SHALL NOT overwrite or reinterpret that evidence
