## Purpose

Turns turnturn's browser client from a protocol observability console into a coding chat workspace: a calm transcript of user and assistant messages with tool work summarized inline, navigable conversations, and the protocol detail available on demand instead of by default.

## ADDED Requirements

### Requirement: Protocol records are projected, never rendered directly

The client SHALL derive what it displays from a conversation projection over durable records and live events, and no view component SHALL branch on a durable record type or a live event type.

#### Scenario: One request is one visual turn

- **GIVEN** one user request causes multiple provider steps and tool actions
- **WHEN** the conversation is displayed
- **THEN** the request, ordered agent steps, actions, results, and final response SHALL appear inside one turn
- **AND** actions SHALL remain correlated by `stepId` and `toolCallId`
- **AND** the terminal turn outcome SHALL appear once

#### Scenario: Unknown shell intent falls back without guessing

- **GIVEN** a shell command whose purpose is not an unambiguous recognized shape
- **WHEN** the action is displayed
- **THEN** it SHALL be labelled as a command rather than assigned a guessed purpose
- **AND** its exact command SHALL remain available
- **AND** display interpretation SHALL NOT affect approval or execution

#### Scenario: Provider steps collapse into one assistant turn

- **GIVEN** a turn in which the model produced text, called tools, and then produced more text
- **WHEN** the conversation is displayed
- **THEN** the transcript SHALL show the user message once
- **AND** each provider step's assistant text SHALL appear as its own message in durable order
- **AND** the tool calls SHALL appear as activity grouped by the provider step that requested them
- **AND** the provider steps themselves SHALL NOT appear as transcript entries

#### Scenario: A projection stays within one session

- **GIVEN** records from two sessions of the same conversation
- **WHEN** the conversation is projected
- **THEN** each session's records SHALL be reduced separately
- **AND** a record whose session does not match the slice it is applied to SHALL be rejected rather than displayed

### Requirement: Live events are superseded by their durable records

The client SHALL display live events only until the durable record covering the same fact arrives, and the transcript SHALL never show the same assistant text twice.

#### Scenario: Streaming text is replaced by the persisted message

- **GIVEN** assistant text deltas streaming for a provider step
- **WHEN** the durable assistant message for that same step arrives
- **THEN** the transcript SHALL show exactly one assistant message for that step
- **AND** its content SHALL be the durable content
- **AND** the streaming indicator SHALL be cleared

#### Scenario: A turn ends without further deltas

- **GIVEN** live text deltas for a turn
- **WHEN** the client holds that turn's terminal durable record
- **THEN** any remaining live deltas for that turn SHALL be discarded
- **AND** discarding non-empty text with no matching durable message SHALL raise a diagnostic

#### Scenario: The same durable record is delivered twice

- **WHEN** a record already held is received again
- **THEN** the projection SHALL be unchanged
- **AND** no duplicate transcript entry SHALL appear

#### Scenario: A record arrives with a gap in the sequence

- **WHEN** a record arrives whose sequence is more than one above the last held sequence
- **THEN** the client SHALL NOT display anything derived from it
- **AND** the client SHALL request the missing records
- **AND** the client SHALL NOT renumber or synthesize a sequence

### Requirement: Tool activity is summarized and expandable

The client SHALL present the tool calls of one provider step as a single collapsed summary that can be expanded, and SHALL NOT show individual tool lifecycle events in the collapsed transcript.

#### Scenario: A wave of tool calls is summarized

- **GIVEN** a provider step that requested a search and two file reads, all completed
- **WHEN** the transcript is displayed
- **THEN** one collapsed entry SHALL describe the work, naming the search and the number of files read
- **AND** expanding it SHALL reveal each call in the order the provider requested them

#### Scenario: Expanded detail per call

- **WHEN** a tool activity entry is expanded
- **THEN** each call SHALL show its name, its validated input, its status, and its duration when known
- **AND** a completed call SHALL show its output
- **AND** a failed call SHALL show its error code and message
- **AND** a call the engine produced rather than a tool SHALL be distinguishable from a real tool failure

#### Scenario: A tool request with no result yet

- **GIVEN** a requested tool call with no terminal record
- **WHEN** the transcript is displayed
- **THEN** the call SHALL appear as running
- **AND** it SHALL NOT be omitted

#### Scenario: Repeated identical calls are preserved

- **GIVEN** a step that read the same file twice with identical input
- **WHEN** the activity is expanded
- **THEN** both calls SHALL appear

#### Scenario: Tool output is not interpreted as Markdown

- **GIVEN** a tool result whose output contains Markdown or HTML syntax
- **WHEN** it is displayed
- **THEN** it SHALL be rendered as literal text
- **AND** no HTML from it SHALL be interpreted

#### Scenario: Long tool output is bounded

- **GIVEN** a tool result far larger than the display limit
- **WHEN** it is expanded
- **THEN** a bounded portion SHALL be shown with the omission stated
- **AND** the full content SHALL be reachable by explicit action
- **AND** a result the tool itself truncated SHALL say so

#### Scenario: A shell command that exited non-zero

- **GIVEN** a shell tool call that ran and exited with a non-zero status
- **WHEN** the activity is expanded
- **THEN** the exit status SHALL be shown
- **AND** the command's output SHALL be shown

### Requirement: Assistant messages render as rich text safely

The client SHALL render assistant message content as Markdown with syntax-highlighted code blocks, tables, and lists, and SHALL NOT execute or interpret HTML from model output.

#### Scenario: Model output contains raw HTML

- **WHEN** an assistant message contains a script tag or an element with an inline event handler
- **THEN** it SHALL NOT be interpreted as HTML
- **AND** no script SHALL execute

#### Scenario: Model output contains a dangerous link

- **WHEN** an assistant message contains a link whose scheme is not an allowed scheme
- **THEN** the link SHALL render as plain text rather than as a navigable link

#### Scenario: Code block presentation

- **WHEN** an assistant message contains a fenced code block
- **THEN** it SHALL be rendered with syntax highlighting for recognized languages
- **AND** it SHALL offer a control that copies the block's exact source
- **AND** an unrecognized or oversized language SHALL render as unhighlighted text rather than failing

#### Scenario: Markdown while still streaming

- **GIVEN** an assistant message still streaming, ending inside an unterminated code fence
- **WHEN** it is displayed
- **THEN** it SHALL render without error
- **AND** the text already received SHALL remain visible

### Requirement: Streaming assistant text arrives with a subtle transition

The client SHALL give newly appended streaming text a brief, non-disruptive visual transition rather than appearing instantly, and SHALL NOT apply that transition to durable content or to any non-text item.

#### Scenario: Text streams in softly

- **GIVEN** an assistant message currently streaming
- **WHEN** a new chunk of text is appended
- **THEN** it SHALL transition in rather than appear at full opacity instantly
- **AND** the transition SHALL apply only to the newly appended chunk

#### Scenario: The durable message never replays the transition

- **GIVEN** a streaming assistant message that reaches its durable, completed form
- **WHEN** the durable content supersedes the live text
- **THEN** the full message SHALL render at full opacity with no transition

#### Scenario: Reduced motion is honored

- **GIVEN** the reader has requested reduced motion
- **WHEN** assistant text streams in
- **THEN** no transition SHALL be applied

### Requirement: Workspace file references are actionable

The client SHALL present workspace file paths in assistant messages and tool activity as file references that resolve through the host application rather than through the browser's filesystem access.

#### Scenario: A file reference with a line number

- **WHEN** an assistant message names a workspace-relative path followed by a line number
- **THEN** it SHALL be rendered as a file reference carrying that path and line
- **AND** activating it SHALL open the file through the host's handler rather than navigating the page

#### Scenario: A path inside a code block

- **WHEN** a path-like string appears inside inline or fenced code
- **THEN** it SHALL NOT be converted into a file reference

#### Scenario: Running in a plain browser

- **GIVEN** a host with no operating-system file handler
- **WHEN** a file reference is activated
- **THEN** the referenced region SHALL be shown in an in-application view
- **AND** the path SHALL be available to copy

### Requirement: Approvals are resolved in place without losing context

The client SHALL present a pending approval inline at the point in the transcript where it was requested, SHALL also present it in a pinned indication visible regardless of scroll position, SHALL show what is being approved verbatim, and SHALL resolve it by submitting a command.

#### Scenario: A shell command awaits approval

- **GIVEN** a pending approval for a shell command
- **WHEN** the transcript is displayed
- **THEN** the exact command text SHALL be shown as literal text, unparsed
- **AND** the working directory SHALL be shown
- **AND** allow and deny SHALL both be offered

#### Scenario: A pending approval is always visible regardless of scroll position

- **GIVEN** a pending approval, inline at its transcript position
- **WHEN** the conversation is displayed, whether or not the inline card is currently in view
- **THEN** a pinned indication SHALL be shown at a fixed position above the transcript
- **AND** it SHALL offer allow and deny directly
- **AND** it SHALL offer to move the viewport to the inline card

#### Scenario: Resolving from the pinned indication or the inline card is the same action

- **GIVEN** a pending approval
- **WHEN** the user chooses allow or deny from the pinned indication
- **THEN** the outcome SHALL be identical to choosing the same action from the inline card
- **AND** both SHALL become unavailable together once resolved

#### Scenario: The pinned indication never moves the viewport by itself

- **GIVEN** a reader who has scrolled away from the end of the transcript
- **WHEN** a pending approval appears or clears
- **THEN** the viewport SHALL NOT move
- **AND** the pinned indication and the "return to newest content" action SHALL both remain available

#### Scenario: Approval resolution is in flight

- **WHEN** the user chooses allow or deny
- **THEN** both choices SHALL become unavailable until the outcome is known
- **AND** a second submission for the same approval SHALL NOT be possible

#### Scenario: The turn is cancelled before the user answers

- **GIVEN** a pending approval
- **WHEN** the turn is cancelled
- **THEN** the approval SHALL be shown as cancelled rather than pending
- **AND** the turn SHALL remain terminal
- **AND** a late resolution refused by the server SHALL be shown as that cancelled state rather than as an error

#### Scenario: Dismissal is not a decision

- **WHEN** the user presses the key that cancels dialogs elsewhere in the application
- **THEN** the approval SHALL NOT be resolved

### Requirement: Composer and turn controls reflect turn state

The client SHALL offer send, stop, retry, and continue according to turn state, and SHALL NOT allow a second concurrent turn in one conversation.

#### Scenario: Sending from the keyboard

- **WHEN** the user presses the submit key with non-empty input and no turn running
- **THEN** the turn SHALL be submitted
- **AND** the user message SHALL appear immediately
- **AND** it SHALL be replaced by its durable record without duplication

#### Scenario: Inserting a newline

- **WHEN** the user presses the submit key together with the newline modifier
- **THEN** a newline SHALL be inserted and nothing SHALL be submitted

#### Scenario: Submitting while a turn is running

- **GIVEN** a running turn
- **WHEN** the user attempts to submit
- **THEN** no turn SHALL be submitted
- **AND** the reason SHALL be stated
- **AND** the typed text SHALL be preserved

#### Scenario: Stopping a running turn

- **GIVEN** a running turn
- **WHEN** the user stops it
- **THEN** the control SHALL show that stopping is in progress
- **AND** the turn SHALL be shown as running until its terminal durable record arrives
- **AND** a terminal state SHALL NOT be displayed before that record exists

#### Scenario: Retrying a recoverable failure

- **GIVEN** a turn that failed with an error marked retryable
- **WHEN** the transcript is displayed
- **THEN** a retry action SHALL be offered
- **AND** choosing it SHALL submit a new turn rather than reopen the failed one

#### Scenario: A failure that cannot be retried

- **GIVEN** a turn that failed with an error not marked retryable
- **WHEN** the transcript is displayed
- **THEN** no retry action SHALL be offered
- **AND** the error code and message SHALL be shown

#### Scenario: Draft text survives navigation

- **GIVEN** unsent text in the composer
- **WHEN** the user switches to another conversation and back
- **THEN** the text SHALL still be there

### Requirement: Turn progress is legible

The client SHALL show which phase a turn is in, and SHALL distinguish transport state from turn state.

#### Scenario: Phases during a tool-using turn

- **WHEN** a turn is waiting on the model, generating text, awaiting an approval, or executing a tool
- **THEN** the phase shown SHALL name that state
- **AND** the phase SHALL be derived from the projection rather than from transport timing

#### Scenario: The event stream drops

- **WHEN** the live event stream disconnects
- **THEN** the client SHALL show that it is reconnecting
- **AND** the transcript already received SHALL remain readable
- **AND** submission SHALL be unavailable until the stream is restored

#### Scenario: Reconnecting after a gap

- **GIVEN** a client that disconnected during a turn that then completed
- **WHEN** the stream is restored
- **THEN** the transcript SHALL match what a client that never disconnected would show
- **AND** no entry SHALL be duplicated or missing

### Requirement: Reading is not interrupted by streaming

The client SHALL follow new content only while the reader is at the end of the transcript, and SHALL NOT move the viewport otherwise.

#### Scenario: Reader scrolls back during streaming

- **GIVEN** a streaming turn
- **WHEN** the user scrolls away from the end
- **THEN** the viewport SHALL stay where the user left it
- **AND** an action to return to the newest content SHALL be offered
- **AND** it SHALL indicate that new content arrived

#### Scenario: Reader returns to the end

- **WHEN** the user takes the action to return to the newest content
- **THEN** the viewport SHALL move to the end
- **AND** subsequent new content SHALL be followed again

### Requirement: Conversations are navigable and restored

The client SHALL present the workspace's conversations, SHALL let the user create, rename, archive, and switch between them, and SHALL restore the selected conversation across a reload.

#### Scenario: Selection survives a reload

- **GIVEN** a selected conversation
- **WHEN** the page is reloaded
- **THEN** the same conversation SHALL be selected and displayed

#### Scenario: Arriving with no selection

- **GIVEN** conversations exist and none is named in the address
- **WHEN** the client loads
- **THEN** it SHALL select the most recently active conversation

#### Scenario: Switching conversations

- **GIVEN** conversation A displayed with its transcript
- **WHEN** the user switches to conversation B and back to A
- **THEN** B's transcript SHALL contain no entry from A
- **AND** A's transcript SHALL contain no entry from B

#### Scenario: A live event for a conversation that is not displayed

- **GIVEN** conversation A displayed
- **WHEN** a live event for conversation B is received
- **THEN** nothing derived from it SHALL appear in A's transcript

#### Scenario: Renaming from the client

- **WHEN** the user renames the displayed conversation
- **THEN** the new title SHALL appear in the header and the conversation list
- **AND** it SHALL persist across a reload

#### Scenario: A conversation that cannot be opened

- **WHEN** the addressed conversation does not exist or cannot be read
- **THEN** the client SHALL state that it could not be opened and offer to retry or return to the list
- **AND** the conversation list SHALL remain usable

#### Scenario: First run

- **GIVEN** no conversations exist
- **WHEN** the client loads
- **THEN** it SHALL show the active workspace and an empty state
- **AND** submitting a first message SHALL create a conversation

#### Scenario: A turn ended by a server restart

- **GIVEN** a conversation whose last turn was finalized as interrupted by a restart
- **WHEN** it is displayed
- **THEN** the transcript SHALL state that the turn was ended by the restart
- **AND** the conversation SHALL accept a new turn

### Requirement: Provider configuration is visible without exposing editable secrets

The client SHALL show the active workspace and model, SHALL make the tool catalog and provider identity inspectable, and SHALL NOT offer to edit server-owned endpoints, headers, or credentials.

#### Scenario: Inspecting the active configuration

- **WHEN** the user opens the configuration detail from the header
- **THEN** the workspace path, provider name, and model SHALL be shown
- **AND** the tools available to the model SHALL be listed
- **AND** no provider credential SHALL be shown
- **AND** the detail SHALL state that these come from server configuration

#### Scenario: Selecting a configured model

- **GIVEN** the server exposes more than one safe model profile
- **WHEN** the user selects another profile while the conversation is idle
- **THEN** the server SHALL create or reuse a session bound to that exact profile
- **AND** the earlier transcript SHALL remain visible behind a session boundary
- **AND** no credential or arbitrary provider URL SHALL cross into the browser

#### Scenario: Model switching while work is active

- **GIVEN** a turn or approval is active in the conversation
- **WHEN** the model selector is displayed
- **THEN** it SHALL be disabled
- **AND** the provider used by the active session SHALL not change

#### Scenario: Models are grouped by their configured provider connection

- **GIVEN** direct Anthropic, LiteLLM, and local Ollama connections are configured
- **WHEN** the user opens the model picker
- **THEN** models SHALL be grouped under those three provider connections
- **AND** the displayed provider SHALL describe the connection used for the request, not an inferred model brand
- **AND** a Claude-named model routed through LiteLLM SHALL remain in the LiteLLM group

#### Scenario: Provider model discovery succeeds

- **GIVEN** a configured provider exposes a supported model-list operation
- **WHEN** the server refreshes that provider
- **THEN** the public catalog SHALL contain stable selectable profiles for its usable models
- **AND** each profile SHALL identify whether it was configured or discovered
- **AND** the catalog SHALL NOT contain credentials, request headers, credential-helper paths, or complete private endpoint URLs

#### Scenario: One provider cannot be discovered

- **GIVEN** one provider times out, rejects authentication, or returns a malformed model list
- **WHEN** catalog refresh completes
- **THEN** that provider SHALL have a fixed unavailable status and non-sensitive error code
- **AND** configured profiles for that provider SHALL remain present
- **AND** models from healthy providers SHALL remain selectable
- **AND** no raw provider response SHALL be sent to the browser

#### Scenario: A discovered model does not advertise tool support

- **GIVEN** discovery reports a model with completion support but without tool capability
- **WHEN** the picker displays it
- **THEN** the model SHALL remain visible but disabled with a reason
- **AND** a model whose tool capability cannot be established SHALL be marked unknown rather than guessed supported

#### Scenario: A model disappears after a session used it

- **GIVEN** a saved session names a stable model profile that is absent from the latest discovery result
- **WHEN** the conversation is reopened
- **THEN** its transcript and provider/model identity SHALL remain readable
- **AND** the model SHALL be shown as unavailable
- **AND** selecting a different available model SHALL create a new session without altering the old session

#### Scenario: Refreshing the catalog

- **GIVEN** the model picker is open and no turn or approval is active
- **WHEN** the user requests a refresh
- **THEN** discovery SHALL run with a bounded timeout independently for each configured provider
- **AND** the picker SHALL replace its snapshot only with the newest completed refresh
- **AND** the refresh request SHALL require the server-issued mutation token

### Requirement: Diagnostics are opt-in and never authoritative

The client SHALL hide protocol and engine diagnostics behind an explicit developer surface that is off by default, and application behavior SHALL NOT depend on that surface being open.

#### Scenario: Default presentation

- **WHEN** the client loads without developer mode enabled
- **THEN** no raw record, live event, sequence number, or engine-state output SHALL be displayed
- **AND** no engine initialization control SHALL be displayed

#### Scenario: Developer surface is opened

- **WHEN** developer mode is enabled
- **THEN** the selected session's durable records, live events, projection diagnostics, engine-state issues, and tool catalog SHALL be inspectable
- **AND** the records shown SHALL be those of the selected session only

#### Scenario: Diagnostics cannot drive the application

- **WHEN** developer mode is enabled or disabled
- **THEN** the transcript, turn state, and conversation list SHALL be unchanged
- **AND** the developer surface SHALL have no way to mutate client state

### Requirement: The client works by keyboard and with assistive technology

The client SHALL be operable by keyboard alone and SHALL announce streaming and turn-state changes to assistive technology.

#### Scenario: Reaching every control by keyboard

- **WHEN** the user moves focus with the keyboard only
- **THEN** the conversation list, header actions, transcript, expandable tool activity, approval choices, and composer SHALL all be reachable
- **AND** the focused control SHALL be visibly indicated

#### Scenario: Announcing progress

- **WHEN** assistant text streams or the turn phase changes
- **THEN** the change SHALL be announced without stealing focus

#### Scenario: Expandable and icon-only controls

- **WHEN** tool activity can be expanded
- **THEN** its control SHALL expose its expanded state
- **AND** every control shown only as an icon SHALL have an accessible name

### Requirement: The client is portable across host environments

The client SHALL reach the engine only through a transport interface, and SHALL NOT import engine runtime modules or depend on being served by a particular host.

#### Scenario: Engine modules are absent from the client

- **WHEN** the client bundle is built
- **THEN** it SHALL contain no engine runtime module
- **AND** it SHALL contain no module that requires a filesystem or process API

#### Scenario: Substituting the transport

- **WHEN** the client is constructed with a transport that is not the HTTP one
- **THEN** conversation listing, replay, live events, and command submission SHALL all work through it
- **AND** no view component SHALL reference the HTTP transport directly
