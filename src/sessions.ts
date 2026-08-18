import { closeSync, openSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

import {
  createAgentSession,
  DefaultResourceLoader,
  type CreateAgentSessionOptions,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionFactory,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type {
  ContentBlock,
  SessionUpdate,
  StopReason,
} from "@agentclientprotocol/sdk";

import {
  eventToSessionUpdate,
  historyToSessionUpdates,
  promptToText,
  toolCallInProgress,
} from "./pi-acp-bridge.ts";

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/gu;

export type ToolAccess = "auto_allow" | "permission" | "deny";

export interface SessionLike {
  readonly sessionId: string;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  history(): SessionUpdate[];
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
}

export interface ToolCallRequest {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  signal?: AbortSignal;
  permissionRequired: boolean;
}

export type PermissionRequest = (input: ToolCallRequest) => Promise<boolean>;
export type BeforeToolCall = (input: ToolCallRequest) => Promise<boolean>;

export interface SessionFactory {
  create(cwd: string, beforeToolCall: BeforeToolCall): Promise<SessionLike>;
  resume(
    sessionId: string,
    cwd: string,
    beforeToolCall: BeforeToolCall,
  ): Promise<SessionLike>;
}

interface SessionRecord {
  session: SessionLike;
  bridge: PromptBridge;
  prompting: boolean;
  cancelled: boolean;
}

type PromptOutcome =
  | { kind: "end_turn" }
  | { kind: "max_tokens" }
  | { kind: "cancelled" }
  | { kind: "error"; message: string };

export function createPiSessionFactory(
  agentDir: string,
  modelRuntime: ModelRuntime,
  model: NonNullable<CreateAgentSessionOptions["model"]>,
): SessionFactory {
  const sessionDir = join(agentDir, "sessions");
  const create = async (
    cwd: string,
    sessionManager: SessionManager,
    beforeToolCall: BeforeToolCall,
  ): Promise<SessionLike> => {
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      noExtensions: true,
      extensionFactories: [permissionExtension(cwd, agentDir, beforeToolCall)],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      model,
      modelRuntime,
      resourceLoader,
      sessionManager,
      tools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    });
    return adaptPiSession(session);
  };
  return {
    create(cwd, beforeToolCall) {
      const resolvedCwd = resolve(cwd);
      return create(
        resolvedCwd,
        durableSessionManager(resolvedCwd, sessionDir),
        beforeToolCall,
      );
    },
    async resume(sessionId, cwd, beforeToolCall) {
      const resolvedCwd = resolve(cwd);
      const matches = (await SessionManager.list(resolvedCwd, sessionDir)).filter(
        (session) => session.id === sessionId,
      );
      if (matches.length === 0) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      if (matches.length > 1) {
        throw new Error(`Multiple sessions have id ${sessionId}`);
      }
      const manager = SessionManager.open(matches[0].path, sessionDir);
      if (
        manager.getSessionId() !== sessionId ||
        resolve(manager.getCwd()) !== resolvedCwd
      ) {
        throw new Error(`Session ${sessionId} does not belong to ${resolvedCwd}`);
      }
      return create(resolvedCwd, manager, beforeToolCall);
    },
  };
}

function durableSessionManager(
  cwd: string,
  sessionDir: string,
): SessionManager {
  const provisional = SessionManager.create(cwd, sessionDir);
  const sessionFile = provisional.getSessionFile();
  if (!sessionFile) {
    throw new Error("Pi did not allocate a session file");
  }
  closeSync(openSync(sessionFile, "wx"));
  return SessionManager.open(sessionFile, sessionDir, cwd);
}

function adaptPiSession(session: AgentSession): SessionLike {
  return {
    sessionId: session.sessionId,
    subscribe: (listener) => session.subscribe(listener),
    history: () => historyToSessionUpdates(session.sessionManager.getBranch()),
    prompt: (text) => session.prompt(text),
    abort: () => session.abort(),
    dispose: () => session.dispose(),
  };
}

function permissionExtension(
  cwd: string,
  agentDir: string,
  beforeToolCall: BeforeToolCall,
): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (event, context) => {
      const access = await toolAccess(event.toolName, event.input, cwd, agentDir);
      if (access === "deny") {
        return {
          block: true,
          reason: "Access to VibeAround product data is denied",
        };
      }
      const allowed = await beforeToolCall({
        sessionId: context.sessionManager.getSessionId(),
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.input,
        signal: context.signal,
        permissionRequired: access === "permission",
      });
      if (!allowed) {
        return { block: true, reason: "Permission denied" };
      }
    });
  };
}

export async function toolAccess(
  toolName: string,
  args: unknown,
  cwd: string,
  agentDir: string,
): Promise<ToolAccess> {
  if (!READ_ONLY_TOOLS.has(toolName)) {
    return "permission";
  }

  const rawPath = readOnlyToolPath(toolName, args);
  if (rawPath === undefined) {
    return "permission";
  }
  const target = resolvePiToolPath(rawPath, cwd);
  if (!target) {
    return "permission";
  }

  const resolvedAgentDir = resolve(agentDir);
  const resolvedDataDir = dirname(dirname(resolvedAgentDir));
  const resolvedWorkspacesDir = join(resolvedDataDir, "workspaces");
  if (isProtectedDataPath(target, resolvedDataDir, resolvedWorkspacesDir)) {
    return "deny";
  }

  const canonicalAgentDir = await realpath(agentDir).catch(() => resolvedAgentDir);
  const dataDir = dirname(dirname(canonicalAgentDir));
  const workspacesDir = join(dataDir, "workspaces");
  if (isProtectedDataPath(target, dataDir, workspacesDir)) {
    return "deny";
  }

  const canonicalTarget = await realpath(target).catch(() => undefined);
  if (!canonicalTarget) {
    return "permission";
  }
  if (isProtectedDataPath(canonicalTarget, dataDir, workspacesDir)) {
    return "deny";
  }

  const canonicalCwd = await realpath(cwd).catch(() => undefined);
  return canonicalCwd && pathIsWithin(canonicalCwd, canonicalTarget)
    ? "auto_allow"
    : "permission";
}

function readOnlyToolPath(toolName: string, args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return undefined;
  }
  const path = (args as Record<string, unknown>).path;
  if (path === undefined && toolName !== "read") {
    return ".";
  }
  return typeof path === "string" ? path : undefined;
}

function resolvePiToolPath(rawPath: string, cwd: string): string | undefined {
  let normalized = rawPath.replace(UNICODE_SPACES, " ");
  if (normalized.startsWith("@")) {
    normalized = normalized.slice(1);
  }
  if (process.platform === "win32") {
    normalized = normalizeWindowsShellPath(normalized);
  }
  if (normalized === "~") {
    normalized = homedir();
  } else if (
    normalized.startsWith("~/") ||
    (process.platform === "win32" && normalized.startsWith("~\\"))
  ) {
    normalized = join(homedir(), normalized.slice(2));
  }
  if (/^file:\/\//u.test(normalized)) {
    try {
      normalized = fileURLToPath(normalized);
    } catch {
      return undefined;
    }
  }
  return isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized);
}

function normalizeWindowsShellPath(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
    return path;
  }
  const match = path.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/iu);
  if (!match) {
    return path;
  }
  const suffix = match[2]?.replaceAll("/", "\\");
  return `${match[1].toUpperCase()}:\\${suffix ?? ""}`;
}

function isProtectedDataPath(
  path: string,
  dataDir: string,
  workspacesDir: string,
): boolean {
  return pathIsWithin(dataDir, path) && !pathIsWithin(workspacesDir, path);
}

function pathIsWithin(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  return relativePath === "" || (
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

class PromptBridge {
  readonly #requestPermission: PermissionRequest;
  #notify: ((update: SessionUpdate) => Promise<void>) | undefined;
  #notifications = Promise.resolve();

  constructor(requestPermission: PermissionRequest) {
    this.#requestPermission = requestPermission;
  }

  bind(notify: (update: SessionUpdate) => Promise<void>): void {
    if (this.#notify) {
      throw new Error("Prompt bridge is already bound");
    }
    this.#notify = notify;
    this.#notifications = Promise.resolve();
  }

  unbind(): void {
    this.#notify = undefined;
  }

  emit(update: SessionUpdate): void {
    const notify = this.#notify;
    if (!notify) {
      throw new Error("Tool call occurred outside an ACP prompt");
    }
    this.#notifications = this.#notifications.then(() => notify(update));
  }

  flush(): Promise<void> {
    return this.#notifications;
  }

  readonly beforeToolCall: BeforeToolCall = async (input) => {
    if (!this.#notify) {
      throw new Error("Tool call occurred outside an ACP prompt");
    }

    // Pi emits tool_execution_start before this blocking hook. Draining the
    // queue guarantees ACP sees the pending tool call before a permission UI.
    await this.flush();
    const allowed = !input.permissionRequired ||
      await this.#requestPermission(input);
    if (allowed) {
      this.emit(toolCallInProgress(input.toolCallId));
      await this.flush();
    }
    return allowed;
  };
}

export class Sessions {
  readonly #factory: SessionFactory;
  readonly #records = new Map<string, SessionRecord>();

  constructor(factory: SessionFactory) {
    this.#factory = factory;
  }

  async create(cwd: string, requestPermission: PermissionRequest): Promise<string> {
    const bridge = new PromptBridge(requestPermission);
    const session = await this.#factory.create(cwd, bridge.beforeToolCall);
    this.#set(session, bridge);
    return session.sessionId;
  }

  async resume(
    sessionId: string,
    cwd: string,
    requestPermission: PermissionRequest,
  ): Promise<void> {
    const bridge = new PromptBridge(requestPermission);
    const session = await this.#factory.resume(
      sessionId,
      cwd,
      bridge.beforeToolCall,
    );
    this.#set(session, bridge);
  }

  async load(
    sessionId: string,
    cwd: string,
    requestPermission: PermissionRequest,
    notify: (update: SessionUpdate) => Promise<void>,
  ): Promise<void> {
    const bridge = new PromptBridge(requestPermission);
    const session = await this.#factory.resume(
      sessionId,
      cwd,
      bridge.beforeToolCall,
    );
    this.#set(session, bridge);
    for (const update of session.history()) {
      await notify(update);
    }
  }

  #set(session: SessionLike, bridge: PromptBridge): void {
    this.#records.get(session.sessionId)?.session.dispose();
    this.#records.set(session.sessionId, {
      session,
      bridge,
      prompting: false,
      cancelled: false,
    });
  }

  async prompt(
    sessionId: string,
    blocks: ContentBlock[],
    notify: (update: SessionUpdate) => Promise<void>,
  ): Promise<StopReason> {
    const record = this.#get(sessionId);
    if (record.prompting) {
      throw new Error(`Session ${sessionId} is already processing a prompt`);
    }

    record.prompting = true;
    record.cancelled = false;
    record.bridge.bind(notify);
    let outcome: PromptOutcome | undefined;
    const unsubscribe = record.session.subscribe((event) => {
      const nextOutcome = promptOutcome(event);
      if (nextOutcome) {
        outcome = nextOutcome;
      }
      const update = eventToSessionUpdate(event);
      if (update) {
        record.bridge.emit(update);
      }
    });

    try {
      await record.session.prompt(promptToText(blocks));
      await record.bridge.flush();
      if (record.cancelled || outcome?.kind === "cancelled") {
        return "cancelled";
      }
      if (outcome?.kind === "error") {
        throw new Error(outcome.message);
      }
      return outcome?.kind === "max_tokens" ? "max_tokens" : "end_turn";
    } catch (error) {
      await record.bridge.flush();
      if (record.cancelled) {
        return "cancelled";
      }
      throw error;
    } finally {
      unsubscribe();
      record.bridge.unbind();
      record.prompting = false;
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const record = this.#get(sessionId);
    record.cancelled = true;
    await record.session.abort();
  }

  dispose(): void {
    for (const record of this.#records.values()) {
      record.session.dispose();
    }
    this.#records.clear();
  }

  #get(sessionId: string): SessionRecord {
    const record = this.#records.get(sessionId);
    if (!record) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    return record;
  }
}

function promptOutcome(event: AgentSessionEvent): PromptOutcome | undefined {
  if (event.type !== "message_end" || event.message.role !== "assistant") {
    return undefined;
  }
  switch (event.message.stopReason) {
    case "length":
      return { kind: "max_tokens" };
    case "aborted":
      return { kind: "cancelled" };
    case "error":
      return {
        kind: "error",
        message: event.message.errorMessage || "Model request failed",
      };
    default:
      return { kind: "end_turn" };
  }
}
