// A minimal in-memory ChatTransport for testing resume.ts without a network or a
// real server (D21) — only getRecords and subscribeEvents are exercised by resume.ts;
// everything else throws if called, since resume.ts has no business calling it.

function notImplemented(name) {
  return () => {
    throw new Error(`fake transport: ${name} is not implemented`);
  };
}

export function createFakeTransport(conversationId, options = {}) {
  let handlers;
  let unsubscribed = false;
  const recordsBySession = new Map();
  const pageLimit = options.pageLimit ?? 100;
  let serverInstanceId = options.serverInstanceId ?? "srv_1";

  return {
    getRuntime: notImplemented("getRuntime"),
    listConversations: notImplemented("listConversations"),
    createConversation: notImplemented("createConversation"),
    getConversation: notImplemented("getConversation"),
    activateConversation: notImplemented("activateConversation"),
    patchConversation: notImplemented("patchConversation"),
    deleteConversation: notImplemented("deleteConversation"),
    getWorkspaceFile: notImplemented("getWorkspaceFile"),
    submitCommand: notImplemented("submitCommand"),
    listProviders: notImplemented("listProviders"),
    refreshProviders: notImplemented("refreshProviders"),

    async getRecords(_conversationId, sessionId, afterSequence) {
      const all = recordsBySession.get(sessionId) ?? [];
      const eligible = all.filter((record) => record.sequence > afterSequence);
      const page = eligible.slice(0, pageLimit);
      const lastSequence = options.reportFullTail
        ? (all.at(-1)?.sequence ?? 0)
        : (page.at(-1)?.sequence ?? afterSequence);
      const hasMore = eligible.length > page.length;
      return { sessionId, records: page, lastSequence, hasMore };
    },

    subscribeEvents(_conversationId, subscriberHandlers) {
      handlers = subscriberHandlers;
      unsubscribed = false;
      return () => {
        unsubscribed = true;
        handlers = undefined;
      };
    },

    // Test-only control surface for driving the fake "server":
    seedRecords(sessionId, records) {
      recordsBySession.set(sessionId, [...(recordsBySession.get(sessionId) ?? []), ...records]);
    },
    setServerInstanceId(id) {
      serverInstanceId = id;
    },
    emitSnapshot(sessions) {
      handlers?.onSnapshot({ conversationId, serverInstanceId, sessions });
    },
    emitEvent(event) {
      handlers?.onEvent(event);
    },
    emitError(error) {
      handlers?.onError(error);
    },
    isSubscribed() {
      return handlers !== undefined && !unsubscribed;
    },
  };
}
