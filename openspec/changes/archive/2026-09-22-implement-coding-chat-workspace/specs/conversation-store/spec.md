## Purpose

Gives turnturn durable, independently addressable conversations: each conversation's engine records survive process restart, can be listed and managed without reading record bodies, and can be replayed back to a client scoped to one session so no conversation ever observes another's records.

## ADDED Requirements

### Requirement: Durable session-scoped record log

The local server SHALL persist every durable record to a file-backed log scoped to the session that produced it, and record sequences SHALL be contiguous from 1 within each session log.

#### Scenario: Records survive process restart

- **GIVEN** a conversation with a completed turn
- **WHEN** the server process exits and a new process starts against the same state directory
- **THEN** the conversation's records SHALL be readable with the same record ids, sequences, and payloads
- **AND** replaying them SHALL report no engine-state issues
- **AND** replaying them SHALL report no provider-history issues

#### Scenario: Sequences are scoped per session

- **WHEN** two sessions in the same conversation each append their first record
- **THEN** each record SHALL be assigned sequence 1 within its own session log
- **AND** neither session's sequence numbering SHALL depend on the other's

#### Scenario: A second writer is refused

- **GIVEN** a server process holding the state directory
- **WHEN** a second server process starts against the same state directory
- **THEN** the second process SHALL refuse to start with a message naming the holder
- **AND** it SHALL NOT append to any existing log

### Requirement: Conversation listing without record scanning

The local server SHALL return the conversation list from a conversation index rather than by reading session record bodies, and listing cost SHALL NOT grow with the number of records a conversation contains.

#### Scenario: Listing a conversation with a long history

- **GIVEN** a conversation holding several hundred durable records
- **WHEN** a client requests the conversation list
- **THEN** the response SHALL include that conversation's id, title, workspace, creation time, last-activity time, and archived state
- **AND** the server SHALL NOT have read the conversation's record payloads to produce it

#### Scenario: The index is rebuilt when missing

- **GIVEN** a state directory containing conversations whose index is absent or unreadable
- **WHEN** the server starts
- **THEN** it SHALL reconstruct the index from the conversations present on disk
- **AND** the conversation list SHALL be served normally
- **AND** the durable record logs SHALL NOT be modified

### Requirement: Conversation lifecycle

The local server SHALL support creating, opening, renaming, archiving, unarchiving, and permanently deleting a conversation, and lifecycle state SHALL survive restart.

#### Scenario: Conversation is created without a session

- **WHEN** a client creates a conversation
- **THEN** the server SHALL assign the conversation id
- **AND** the conversation SHALL appear in the list with no title
- **AND** no session SHALL be created until the conversation is activated

#### Scenario: Title is derived from the first user message

- **GIVEN** an untitled conversation
- **WHEN** its first turn is submitted
- **THEN** the server SHALL derive a title from that message's text
- **AND** the derived title SHALL be at most 60 characters

#### Scenario: Manual rename wins over derivation

- **GIVEN** a conversation the user has renamed
- **WHEN** a later turn is submitted
- **THEN** the title SHALL NOT be overwritten by derivation

#### Scenario: Archived conversations are hidden by default

- **WHEN** a conversation is archived
- **THEN** it SHALL be excluded from the default conversation list
- **AND** it SHALL be returned when archived conversations are explicitly requested
- **AND** its durable records SHALL remain readable

#### Scenario: Deletion requires archiving first

- **WHEN** a client requests permanent deletion of a conversation that is not archived
- **THEN** the server SHALL refuse the request
- **AND** the conversation SHALL remain intact

### Requirement: Session activation binds a conversation to a provider and model

The local server SHALL assign session identity, and SHALL reuse a conversation's most recent session only when that session's recorded provider and model match the server's current configuration.

#### Scenario: Reopening a conversation under unchanged configuration

- **GIVEN** a conversation whose most recent session recorded the server's current provider and model
- **WHEN** the client activates that conversation
- **THEN** the server SHALL return that existing session
- **AND** the model-visible history for the next turn SHALL include the session's earlier turns

#### Scenario: Reopening a conversation after the model changed

- **GIVEN** a conversation whose most recent session recorded a different model
- **WHEN** the client activates that conversation
- **THEN** the server SHALL create a new session in the same conversation
- **AND** the conversation SHALL retain both sessions in order
- **AND** the client SHALL be able to tell that the provider or model changed between them

#### Scenario: The client does not assign durable identity

- **WHEN** a client asks to start or open a conversation
- **THEN** the conversation id and session id SHALL be assigned by the server
- **AND** a command naming a session the server does not hold SHALL be rejected with a distinct code

### Requirement: Session-scoped record retrieval

The local server SHALL expose durable replay per session, and SHALL NOT expose a record endpoint whose results span conversations.

#### Scenario: Replay after a sequence

- **GIVEN** a client holding a session's records through sequence `N`
- **WHEN** it requests that session's records after `N`
- **THEN** the server SHALL return only records from that session with `sequence > N`
- **AND** the records SHALL be contiguous and in ascending sequence order

#### Scenario: Records of another conversation are unreachable

- **WHEN** a client requests records for a session id that does not belong to the conversation named in the request
- **THEN** the server SHALL refuse the request
- **AND** it SHALL NOT return records from either conversation

### Requirement: Conversation-scoped live event stream

The local server SHALL deliver live events only to subscribers of the conversation that produced them, and SHALL provide a resume cursor per session at subscription time.

#### Scenario: Events do not cross conversations

- **GIVEN** one subscriber for conversation A and one for conversation B
- **WHEN** a turn runs in conversation A
- **THEN** A's subscriber SHALL receive A's live events
- **AND** B's subscriber SHALL receive none of them

#### Scenario: Subscription opens with a per-session cursor

- **WHEN** a client subscribes to a conversation's live events
- **THEN** the first frame SHALL carry the last durable sequence for each of that conversation's sessions
- **AND** it SHALL carry an identifier for the current server process
- **AND** every durable record SHALL be observable exactly once by combining replay up to those cursors with the events that follow

#### Scenario: Server restart is detectable

- **GIVEN** a client that was subscribed before the server restarted
- **WHEN** it subscribes again
- **THEN** the server process identifier SHALL differ from the previous one
- **AND** the client SHALL be able to discard live state and replay from durable records

### Requirement: Interrupted turns are finalized, never left running

When a session log's last turn has no terminal record, the local server SHALL append terminal records for it before serving that session to any client, and SHALL do so at most once.

#### Scenario: A turn interrupted by process exit

- **GIVEN** a session log whose final records describe a running turn with an unterminated tool call
- **WHEN** the conversation is next opened
- **THEN** the server SHALL append a terminal result for that tool call marked as engine-produced
- **AND** it SHALL append a terminal record for the turn stating that the server restarted
- **AND** replaying the session SHALL report no engine-state issues
- **AND** every requested tool call SHALL have exactly one terminal result

#### Scenario: Repair is idempotent

- **GIVEN** a session already repaired on a previous open
- **WHEN** the conversation is opened again
- **THEN** no further records SHALL be appended

### Requirement: Recoverable log corruption does not destroy a conversation

The local server SHALL recover a session log whose final line is incomplete, and SHALL preserve the original bytes before modifying it.

#### Scenario: Torn final line after an unclean shutdown

- **GIVEN** a session log whose last line is truncated mid-JSON
- **WHEN** the conversation is opened
- **THEN** the server SHALL retain a copy of the original log
- **AND** it SHALL serve the valid records preceding the torn line
- **AND** subsequent appends SHALL continue from the next sequence after the last valid record
- **AND** the conversation SHALL remain usable

#### Scenario: Corruption that is not at the tail

- **GIVEN** a session log that is invalid before its final line
- **WHEN** the conversation is opened
- **THEN** the server SHALL report the conversation as unopenable with a diagnostic
- **AND** it SHALL NOT modify the log
- **AND** other conversations SHALL remain usable

### Requirement: Storage versioning

The local server SHALL record a storage version for its state directory and SHALL refuse to operate on a state directory newer than it understands.

#### Scenario: State directory from a future version

- **GIVEN** a state directory recording a storage version higher than the server supports
- **WHEN** the server starts
- **THEN** it SHALL refuse to start with a message naming both versions
- **AND** it SHALL NOT read, migrate, or write any conversation

#### Scenario: Fresh state directory

- **WHEN** the server starts against an empty or absent state directory
- **THEN** it SHALL initialize it and record the current storage version

### Requirement: Conversation state is stored outside the workspace

The local server SHALL store conversation state outside the configured workspace roots by default.

#### Scenario: Workspace tools do not observe conversation state

- **GIVEN** a conversation with persisted records
- **WHEN** a workspace search or glob tool runs over the workspace root
- **THEN** the conversation's stored records SHALL NOT appear in its results

### Requirement: Local-only request validation

The local server SHALL reject state-changing requests that do not originate from its own origin, and SHALL require a per-process secret that is not guessable by another local program.

#### Scenario: Cross-origin request from a visited web page

- **WHEN** a request arrives whose `Origin` is not the server's own origin
- **THEN** the server SHALL refuse it
- **AND** no command SHALL reach the engine

#### Scenario: Request addressed through a rebound hostname

- **WHEN** a request arrives whose `Host` is neither the loopback address nor `localhost` with the configured port
- **THEN** the server SHALL refuse it

#### Scenario: Local program without the session secret

- **WHEN** a request to submit a command arrives without the secret the server generated at startup
- **THEN** the server SHALL refuse it
- **AND** no tool SHALL be executed

### Requirement: Provider credentials never reach the client

No response from the local server SHALL contain a provider API key or a provider authorization header, including diagnostic responses.

#### Scenario: Runtime configuration is requested

- **WHEN** a client requests the server's runtime configuration
- **THEN** the response SHALL identify the workspace, provider, and model
- **AND** it SHALL NOT contain the provider API key
- **AND** it SHALL NOT contain the full provider base URL

#### Scenario: Diagnostic provider request is inspected

- **WHEN** a client requests the most recent provider request for diagnosis
- **THEN** the response SHALL omit provider request headers
- **AND** it SHALL NOT contain the provider API key

### Requirement: Workspace file reads are confined

When the local server serves workspace file content for a client-side file reference, it SHALL confine the target to the configured workspace roots after resolving symbolic links, and SHALL bound the response.

#### Scenario: Path escaping the workspace

- **WHEN** a client requests a file whose resolved real path lies outside every configured workspace root
- **THEN** the server SHALL refuse the request
- **AND** it SHALL NOT disclose whether the file exists

#### Scenario: Binary or oversized file

- **WHEN** a client requests a file that is not valid UTF-8 text, or is larger than the configured limit
- **THEN** the server SHALL refuse to return its content
- **AND** it SHALL state why
