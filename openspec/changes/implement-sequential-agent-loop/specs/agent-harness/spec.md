## ADDED Requirements

### Requirement: Sequential Engine Boundary
turnturn SHALL implement the first agent loop through canonical protocol envelopes instead of renderer callbacks.

#### Scenario: Command enters local engine
- **WHEN** a local caller submits a `CommandEnvelope`
- **THEN** the engine handles it without provider-native objects, renderer callbacks, or shared client state crossing the boundary.

### Requirement: Durable Before Live
turnturn SHALL persist accepted state changes before publishing corresponding terminal live events.

#### Scenario: Turn starts
- **WHEN** the engine accepts a submitted turn
- **THEN** it appends durable turn/input records before publishing live turn progress.

### Requirement: Scripted Provider Step
turnturn SHALL support a scripted provider for deterministic engine tests.

#### Scenario: Provider requests a tool
- **WHEN** the scripted provider emits a tool request
- **THEN** the engine records a canonical `tool.requested` durable record
- **AND** the tool request can be replayed into provider history.

### Requirement: Sequential Tool Execution
turnturn SHALL execute v1 tool requests sequentially.

#### Scenario: Multiple tools share one provider step
- **WHEN** a provider step emits multiple tool calls
- **THEN** the engine executes them one at a time in provider order
- **AND** each tool call reaches exactly one terminal durable result.

### Requirement: Policy Gate
turnturn SHALL evaluate tool policy before executor invocation.

#### Scenario: Policy denies a tool
- **WHEN** policy denies a requested tool
- **THEN** the executor is not invoked
- **AND** the engine records a terminal denied tool result where a model-visible result can be safely produced.

### Requirement: Recoverable Tool Error
turnturn SHALL keep recoverable tool failures inside the turn loop.

#### Scenario: Tool executor fails recoverably
- **WHEN** a tool executor returns a recoverable error
- **THEN** the engine records a failed terminal tool result
- **AND** the provider can receive that result in a later step.
