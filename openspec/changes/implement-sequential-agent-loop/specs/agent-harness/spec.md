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

### Requirement: Real Provider Turn
turnturn SHALL complete a turn against a real streaming provider, not only a scripted one.

#### Scenario: Provider interleaves text and tool calls
- **WHEN** a real provider stream interleaves assistant text with tool-call argument fragments
- **THEN** the adapter assembles a complete tool call before the engine dispatches it
- **AND** an unparseable argument buffer produces a terminal outcome rather than a dispatched call or a parse exception.

### Requirement: Core Tool Set
turnturn SHALL provide read, write, edit, glob, grep, and shell tools confined to the workspace.

#### Scenario: Model edits a file
- **WHEN** the model requests an edit inside the workspace
- **THEN** the change is shown as a diff before it is applied
- **AND** the result is verifiable on disk or reported as a structured failure with no partial write.

#### Scenario: Path escapes the workspace
- **WHEN** a tool call resolves outside the configured workspace roots, including via a symlink
- **THEN** the call is refused before execution.

### Requirement: Serialized Client Boundary
turnturn SHALL deliver commands and events to local clients through the same serialized shape a remote client would use.

#### Scenario: Renderer observes a turn
- **WHEN** a renderer subscribes to a running turn
- **THEN** every command and message crosses the transport as serialized JSON
- **AND** a payload that cannot be serialized fails at the boundary rather than reaching the renderer.

#### Scenario: Subscriber resumes
- **WHEN** a subscriber resumes after a gap
- **THEN** it receives the durable records it missed, ordered by durable sequence
- **AND** it does not receive live events emitted during the gap.
