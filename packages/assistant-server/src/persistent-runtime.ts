import { randomUUID } from "node:crypto";
import type { ModelCatalog } from "./model-catalog.js";
import type { AssistantRuntime } from "./runtime.js";
import { SessionRuntimeRegistry } from "./session-runtime.js";
import { ConversationStore } from "./storage/conversation-store.js";
import { openStateDirectory, type StateDirectory } from "./storage/state-dir.js";

export interface PersistentRuntime {
  readonly state: StateDirectory;
  readonly store: ConversationStore;
  readonly sessions: SessionRuntimeRegistry;
  readonly models: ModelCatalog;
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
    const defaultProfile = runtime.models.defaultProfile;
    const store = await ConversationStore.open(state, {
      provider: defaultProfile.provider,
      model: defaultProfile.model,
      modelProfileId: defaultProfile.id,
    });
    const sessions = new SessionRuntimeRegistry({
      store,
      provider: runtime.provider,
      providerForSession: (session) => {
        const profile = runtime.models.resolve(session);
        return profile.id === runtime.models.defaultProfileId
          ? runtime.provider
          : runtime.models.createProvider(profile);
      },
      models: runtime.models,
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
      models: runtime.models,
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
