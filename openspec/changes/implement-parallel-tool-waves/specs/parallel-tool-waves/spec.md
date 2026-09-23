# Parallel Tool Waves

## ADDED Requirements

### Requirement: Independent read-only calls overlap within a provider step

The engine SHALL run contiguous, admitted built-in read-only calls concurrently, with a fixed upper bound. It SHALL keep mutating, unknown, and approval-requiring calls as ordering barriers.

#### Scenario: Two reads and a write

- **GIVEN** one provider step requests `read A`, `grep B`, `edit C`, and `read D` in that order
- **WHEN** the tool wave executes
- **THEN** A and B may overlap
- **AND** C starts only after both settle
- **AND** D starts only after C has a terminal result

#### Scenario: Unknown or approval-requiring call

- **GIVEN** an unknown tool or a call whose policy requires approval between two reads
- **WHEN** the wave reaches that call
- **THEN** no later read starts across that barrier
- **AND** the existing validation, policy, and approval rules remain in force

### Requirement: Durable results are complete and deterministic

Every requested call SHALL have exactly one terminal result before the turn terminal record. The next provider step SHALL receive each tool result paired with its request and ordered by provider call order, independent of actual completion order.

#### Scenario: Siblings finish in reverse order

- **GIVEN** two admitted reads whose second execution finishes first
- **WHEN** both settle
- **THEN** their durable terminal results are appended in provider order with their original call ids
- **AND** both reducers report no issues

#### Scenario: One read fails

- **GIVEN** two admitted reads and one returns a recoverable failure
- **WHEN** the wave settles
- **THEN** the successful sibling retains its own result
- **AND** the failure is returned to the next provider step as that call's result

#### Scenario: An executor throws while its sibling succeeds

- **GIVEN** two admitted reads and one executor throws
- **WHEN** the wave settles
- **THEN** only that call receives a failed result
- **AND** the successful sibling's result remains available to the next provider step
- **AND** neither call receives a duplicate terminal record

#### Scenario: Policy service fails after earlier requests were recorded

- **GIVEN** an earlier wave call has a durable request and a later policy decision throws
- **WHEN** the turn fails
- **THEN** the earlier requested call receives one terminal result before `turn.failed`
- **AND** the policy exception is not presented as an ordinary recoverable tool failure

### Requirement: Admitted read-only calls have independent bounded deadlines

Each admitted built-in read-only call SHALL have a host-configured, finite deadline. A timeout SHALL fail only that call; a late executor settlement SHALL NOT create another result or model-visible output. The built-in read/search implementations SHALL cooperate with cancellation where possible. This requirement does not claim physical termination of an arbitrary executor or a synthetic timeout for mutating tools.

#### Scenario: One read times out and its sibling succeeds

- **GIVEN** two admitted reads with independent deadlines and one does not settle before its deadline
- **WHEN** the timed-out call reaches its deadline
- **THEN** it receives one failed result with code `TOOL_TIMEOUT`
- **AND** the sibling continues and retains its own outcome
- **AND** both terminal records are appended in provider order

#### Scenario: Timed-out executor settles late

- **GIVEN** a read that ignores its abort signal and resolves after its logical timeout
- **WHEN** that late resolution or callback arrives
- **THEN** it adds no second terminal record or model-visible output
- **AND** it cannot change the terminal turn

### Requirement: Cancellation cannot leave a partial wave or resurrect a turn

Cancellation SHALL stop admission of later waves, signal in-flight calls, drain or abort every requested call, and write `turn.aborted` only after their terminal records.

#### Scenario: Cancel while reads are active

- **GIVEN** two reads already requested and executing
- **WHEN** `turn.cancel` is accepted
- **THEN** both calls receive one terminal result before `turn.aborted`
- **AND** no later wave starts or late result changes the terminal turn

#### Scenario: Cancel before a later wave is admitted

- **GIVEN** a later read-only wave is still waiting behind a barrier
- **WHEN** the turn is cancelled
- **THEN** no call from that later wave starts or acquires a synthetic request/result pair
- **AND** every already-requested call receives one terminal result before `turn.aborted`

#### Scenario: Restart with an interrupted wave

- **GIVEN** a durable session log ending with requested but unterminated read calls
- **WHEN** the session opens after process restart
- **THEN** existing repair finalizes those calls and the turn exactly once
- **AND** both state and provider-history replay remain valid
