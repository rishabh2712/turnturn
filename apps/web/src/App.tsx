import { useEffect, useMemo, useState } from "react";
import { command, type DebugState, type DurableRecord, id, type LiveEvent } from "./protocol";
import { chatFromRecords, pendingApprovalFrom, timelineFromRecords } from "./state";
import { fetchDebugState, fetchRecords, sendCommand, subscribeEvents, type TransportEvent } from "./transport";
import "./styles.css";

export function App() {
  const [conversationId] = useState(() => id("conv"));
  const [sessionId] = useState(() => id("sess"));
  const [input, setInput] = useState("Say hello, then use a tool if you need one.");
  const [records, setRecords] = useState<readonly DurableRecord[]>([]);
  const [liveEvents, setLiveEvents] = useState<readonly LiveEvent[]>([]);
  const [lastSequence, setLastSequence] = useState(0);
  const [status, setStatus] = useState("Disconnected");
  const [debug, setDebug] = useState<DebugState | undefined>();
  const [currentTurnId, setCurrentTurnId] = useState<string | undefined>();
  const [initialized, setInitialized] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const buffered: LiveEvent[] = [];
    let hydrated = false;
    const unsubscribe = subscribeEvents((event: TransportEvent) => {
      if (event.kind === "error") {
        setStatus("Event stream reconnecting");
        return;
      }
      if (event.kind === "snapshot") {
        setStatus(`Connected at sequence ${event.snapshot.snapshotSequence}`);
        fetchRecords(lastSequence)
          .then((nextRecords) => {
            const snapshotRecords = nextRecords.filter((record) => record.sequence <= event.snapshot.snapshotSequence);
            applyRecords(snapshotRecords);
            setLiveEvents((current) => [...current, ...buffered]);
            hydrated = true;
          })
          .catch((error: unknown) => setStatus(error instanceof Error ? error.message : String(error)));
        return;
      }
      if (!hydrated) {
        buffered.push(event.event);
        return;
      }
      setLiveEvents((current) => [...current, event.event]);
    });
    return unsubscribe;
  }, [lastSequence]);

  const timeline = useMemo(() => timelineFromRecords(records, liveEvents), [records, liveEvents]);
  const chat = useMemo(() => chatFromRecords(records, liveEvents), [records, liveEvents]);
  const approval = useMemo(() => pendingApprovalFrom(records, liveEvents), [records, liveEvents]);

  async function initialize() {
    if (initialized) return;
    const createConversation = command("conversation.create", { conversationId, sessionId }, { title: "Web harness" });
    const createSession = command("session.create", { conversationId, sessionId }, { provider: "local" });
    await sendAndApply(createConversation);
    await sendAndApply(createSession);
    setInitialized(true);
    await refreshDebug();
  }

  async function submitTurn() {
    if (busy) return;
    setBusy(true);
    if (!initialized) await initialize();
    const turnId = id("turn");
    setCurrentTurnId(turnId);
    const submit = command("turn.submit", { conversationId, sessionId, turnId }, { input });
    try {
      await sendAndApply(submit);
      await refreshDebug();
      setInput("");
    } finally {
      setBusy(false);
    }
  }

  async function cancelTurn() {
    if (currentTurnId === undefined) return;
    await sendAndApply(
      command("turn.cancel", { conversationId, sessionId, turnId: currentTurnId }, { reason: "cancelled from web" }),
    );
  }

  async function resolveApproval(decision: "allow" | "deny") {
    if (approval === undefined) return;
    await sendAndApply(
      command(
        "approval.resolve",
        {
          approvalId: approval.approvalId,
          conversationId: approval.conversationId,
          sessionId: approval.sessionId,
          toolCallId: approval.toolCallId,
          turnId: approval.turnId,
        },
        { decision },
      ),
    );
  }

  async function sendAndApply(nextCommand: ReturnType<typeof command>) {
    setStatus(`Sending ${nextCommand.type}`);
    const outcome = await sendCommand(nextCommand);
    if (outcome.kind === "rejected") {
      setStatus(`${outcome.code}: ${outcome.message}`);
      return;
    }
    applyRecords(outcome.records ?? []);
    setStatus(`${nextCommand.type} ${outcome.kind}`);
  }

  function applyRecords(nextRecords: readonly DurableRecord[]) {
    if (nextRecords.length === 0) return;
    setRecords((current) => mergeRecords(current, nextRecords));
    setLastSequence((current) => Math.max(current, ...nextRecords.map((record) => record.sequence)));
  }

  async function refreshDebug() {
    setDebug(await fetchDebugState());
  }

  return (
    <main className="shell">
      <section className="topbar">
        <div>
          <p className="eyebrow">Turnturn web harness</p>
          <h1>Chat</h1>
          <p className="muted">{status}</p>
        </div>
        <div className="actions">
          <button type="button" onClick={initialize} disabled={initialized}>
            Initialize
          </button>
          <button type="button" onClick={cancelTurn}>
            Cancel
          </button>
          <button type="button" onClick={refreshDebug}>
            Refresh debug
          </button>
        </div>
      </section>

      {approval !== undefined ? (
        <section className="approval">
          <h2>Approval requested</h2>
          <p>{approval.reason}</p>
          <button type="button" onClick={() => resolveApproval("allow")}>
            Allow
          </button>
          <button type="button" onClick={() => resolveApproval("deny")}>
            Deny
          </button>
        </section>
      ) : null}

      <section className="chat-layout">
        <article className="chat-panel">
          <div className="chat-log">
            {chat.length === 0 ? (
              <div className="empty-chat">
                <h2>Start a conversation</h2>
                <p>Ask the model a question. The server will create the conversation/session on first send.</p>
              </div>
            ) : (
              chat.map((item) =>
                item.kind === "message" ? (
                  <div className={`message ${item.role}`} key={item.key}>
                    <div className="avatar">{item.role === "user" ? "You" : "AI"}</div>
                    <div className="bubble">
                      <div className="message-text">{item.text}</div>
                      {item.streaming ? <span className="streaming">streaming…</span> : null}
                    </div>
                  </div>
                ) : (
                  <div className={`chat-event ${item.tone}`} key={item.key}>
                    <strong>{item.title}</strong>
                    {item.detail ? <code>{item.detail}</code> : null}
                  </div>
                ),
              )
            )}
          </div>

          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              void submitTurn();
            }}
          >
            <textarea
              placeholder="Message Turnturn…"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void submitTurn();
                }
              }}
            />
            <button type="submit" disabled={busy || input.trim().length === 0}>
              {busy ? "Sending…" : "Send"}
            </button>
          </form>
        </article>

        <aside className="debug-panel">
          <section>
            <h2>Protocol timeline</h2>
            <ol className="timeline">
              {timeline.map((item) => (
                <li key={item.key}>
                  <span>{item.sequence ?? "live"}</span>
                  <strong>{item.title}</strong>
                  <code>{item.detail}</code>
                </li>
              ))}
            </ol>
          </section>
          <section>
            <h2>Debug</h2>
            <pre>{JSON.stringify(debug ?? { issues: [], lastSequence }, null, 2)}</pre>
          </section>
        </aside>
      </section>
    </main>
  );
}

function mergeRecords(current: readonly DurableRecord[], next: readonly DurableRecord[]): readonly DurableRecord[] {
  const bySequence = new Map(current.map((record) => [record.sequence, record]));
  for (const record of next) bySequence.set(record.sequence, record);
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
}
