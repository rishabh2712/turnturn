# Product-Grade Coding Turn

This change defines observable browser behavior for a single selected coding conversation. It does not redefine protocol, engine, provider, or policy behavior, and it does not promote the archived M3.5 spec to accepted status.

## ADDED Requirements

### Requirement: A turn remains understandable while it runs

The default chat view SHALL present the user request, assistant progress/answer, grouped tool actions and results, pending decision, and terminal outcome as one ordered turn. Diagnostic provider frames and durable record types SHALL remain outside the default transcript.

#### Scenario: A tool-using answer streams

- **GIVEN** a selected conversation with a running turn
- **WHEN** assistant text and tool activity arrive through live events and durable records
- **THEN** the user sees progress rather than a frozen pane
- **AND** the final durable facts replace provisional live content without duplicate text or action cards

#### Scenario: The user reads earlier content

- **GIVEN** the user has scrolled away from the latest turn
- **WHEN** new live content arrives
- **THEN** the viewport does not forcibly jump
- **AND** a clear path to the latest turn remains available

### Requirement: Decisions remain actionable across reload

A pending approval SHALL be derived from the recovered conversation state and SHALL be visible both near its tool action and in a discoverable pending-action location. Both surfaces SHALL resolve the same approval identity through one controller operation.

#### Scenario: Reload while awaiting approval

- **GIVEN** a durable pending tool approval
- **WHEN** the browser reloads and reconnects
- **THEN** the approval is still visible and actionable
- **AND** its exact command or input and relevant scope are inspectable before Allow or Deny

#### Scenario: Approval is no longer pending

- **GIVEN** another client or a cancellation has already resolved the approval
- **WHEN** the user acts on a stale card
- **THEN** the client refreshes from durable state and shows the current outcome
- **AND** it does not claim a local button click authorized execution

### Requirement: Controls reflect supported turn states

Stop SHALL be offered for an active turn backed by `turn.cancel`. Its pending, failure, and terminal outcomes SHALL be visible; a failed command SHALL NOT erase the user's draft or misrepresent a turn as stopped. Retry is outside this change because its meaning and command path are not yet defined.

#### Scenario: Stop during a running turn

- **WHEN** the user requests stop for an active turn
- **THEN** the interface shows the command is pending until the durable terminal outcome appears
- **AND** any later provider text does not visually resurrect the terminal turn

### Requirement: Tool displays remain honest and inspectable

Known tool actions SHALL have concise, typed summaries and expandable exact details. Unknown or ambiguous actions SHALL use neutral fallback wording. Display interpretation SHALL NOT affect tool execution or policy.

#### Scenario: Completed file edit

- **GIVEN** a completed edit result with before/after data
- **WHEN** the tool card is opened
- **THEN** the interface labels the action as applied and shows the available comparison
- **AND** it does not imply that this is a pre-apply approval preview

#### Scenario: Unknown shell purpose

- **GIVEN** a shell command not recognized with certainty
- **WHEN** its action is summarized
- **THEN** it is called a command, not assigned a guessed purpose
- **AND** the exact command remains available before a decision

### Requirement: Selected conversation owns its own live lifetime

Switching conversations SHALL dispose the previous conversation's UI subscription and recover the selected conversation from its own durable cursor. Provisional events or pending local actions from one conversation SHALL NOT appear in another.

#### Scenario: Switch while a turn streams

- **GIVEN** conversation A has a streaming turn
- **WHEN** the user selects conversation B and later returns to A
- **THEN** B never displays A's live content or approval actions
- **AND** A resumes from its durable state without duplicate transcript items
