import { randomUUID } from "node:crypto";
import type { AssistantRuntime } from "./runtime.js";
import { SessionRuntimeRegistry } from "./session-runtime.js";
import { ConversationStore } from "./storage/conversation-store.js";
import { openStateDirectory, type StateDirectory } from "./storage/state-dir.js";

export interface PersistentRuntime {
  readonly state: StateDirectory;
  readonly store: ConversationStore;
  readonly sessions: SessionRuntimeRegistry;
  readonly serverInstanceId: string;
  close(): Promise<void>;
}

export async function createPersistentRuntime(
  runtime: AssistantRuntime,
  options: { readonly stateRoot?: string; readonly port?: number } = {},
): Promise<PersistentRuntime> {
  const state = await openStateDirectory({
    workspace: runtime.config.workspace,
    ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
    ...(options.port === undefined ? {} : { port: options.port }),
  });
  try {
    const store = await ConversationStore.open(state, {
      provider: runtime.config.provider,
      model: runtime.config.model,
    });
    const sessions = new SessionRuntimeRegistry({
      store,
      provider: runtime.provider,
      tools: runtime.tools,
      policy: runtime.policy,
      live: runtime.live,
      ids: runtime.ids,
      clock: runtime.clock,
      trace: {
        enabled: runtime.config.trace ?? false,
        ...(runtime.config.traceRawResponseMaxBytes === undefined
          ? {}
          : { rawResponseMaxBytes: runtime.config.traceRawResponseMaxBytes }),
      },
    });
    let closing: Promise<void> | undefined;
    return {
      state,
      store,
      sessions,
      serverInstanceId: `srv_${randomUUID()}`,
      close: () => {
        closing ??= sessions.waitForIdle().then(() => state.close());
        return closing;
      },
    };
  } catch (error) {
    await state.close();
    throw error;
  }
}
