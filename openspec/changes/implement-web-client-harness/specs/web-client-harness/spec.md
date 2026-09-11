# web-client-harness spec delta

## ADDED Requirements

### Requirement: Serialized browser transport

The web client SHALL communicate with the assistant engine only through serialized HTTP/SSE transport.

#### Scenario: Command submission crosses JSON boundary

- **WHEN** the browser submits a command
- **THEN** the local server SHALL parse it from JSON
- **AND** submit it to the engine as a `CommandEnvelope`
- **AND** return a serialized command outcome
- **AND** the browser SHALL NOT hold an engine object reference

### Requirement: Durable replay by sequence

The local server SHALL expose durable replay by record sequence.

#### Scenario: Resume after dropped event stream

- **GIVEN** the browser has seen durable records through sequence `N`
- **WHEN** the event stream reconnects
- **THEN** the browser SHALL request records after `N`
- **AND** the server SHALL return only records with `sequence > N`
- **AND** the browser SHALL repair its timeline from durable records rather than live event ids

### Requirement: Live events over SSE

The local server SHALL stream live events to the browser over SSE.

#### Scenario: Assistant text streams before durable completion

- **WHEN** the engine publishes assistant text deltas
- **THEN** the server SHALL stream them as live SSE events
- **AND** the browser MAY render them optimistically
- **BUT** completed assistant text SHALL be recovered from durable records

### Requirement: Approval and cancellation through commands

The browser SHALL resolve approvals and cancellations by submitting commands.

#### Scenario: User approves a pending tool

- **GIVEN** a pending approval is visible in the browser
- **WHEN** the user chooses allow or deny
- **THEN** the browser SHALL submit an `approval.resolve` command
- **AND** the server SHALL not expose a callback or promise handle to the browser

### Requirement: Localhost-only harness

The web harness SHALL bind to localhost by default and SHALL NOT add remote access or authentication in this change.

#### Scenario: Server starts with default config

- **WHEN** the local server starts
- **THEN** it SHALL listen on `127.0.0.1`
- **AND** it SHALL use explicit local provider/workspace configuration

