import * as vscode from "vscode";
import type { OpenCodeClient } from "../client/http";
import { normalizeAgent, normalizeCommand, normalizeList, normalizeModel, normalizeSkill } from "../shared/adapter";
import type { AgentInfo, CommandInfo, ModelInfo, ModelRef, SkillInfo } from "../shared/api";
import type { HostMessage } from "../shared/protocol";
import { STRINGS } from "../shared/strings";

/** Slash commands the extension resolves itself, advertised like server commands for discovery. */
const LOCAL_COMMANDS: CommandInfo[] = [{ name: "fork", description: STRINGS.forkCommand }];

const MODEL_KEY = "opencode.lastModel";
const AGENT_KEY = "opencode.lastAgent";

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Owns the server-provided catalog: models, agents, skills, slash commands and the user's
 * selection. Keeping it separate from the controller makes the chat glue easier to reason about
 * and lets catalog refresh logic be tested without a server.
 */
export class CatalogService {
  models: ModelInfo[] = [];
  agents: AgentInfo[] = [];
  skills: SkillInfo[] = [];
  commands: CommandInfo[] = [];
  selectedModel: ModelRef | undefined;
  selectedAgent: string | undefined;
  /** Plugin skills/commands are registered only once a session exists. */
  private warmedUp = false;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly post: (msg: HostMessage) => void,
    private readonly log: (line: string) => void,
    private readonly canPost: () => boolean,
  ) {}

  get isWarmedUp(): boolean {
    return this.warmedUp;
  }

  markWarmedUp(): void {
    this.warmedUp = true;
  }

  resetWarmUp(): void {
    this.warmedUp = false;
  }

  /** Rebuild models/agents and restore the remembered selection from globalState. */
  setModelsAndAgents(rawModels: ModelInfo[], defaultModel: ModelInfo | null, rawAgents: AgentInfo[]): void {
    this.models = normalizeList(rawModels, normalizeModel).filter((m) => m.enabled !== false);
    this.agents = normalizeList(rawAgents, normalizeAgent).filter((a) => a.mode !== "subagent" && !a.hidden);

    const saved = this.ctx.globalState.get<ModelRef>(MODEL_KEY);
    const exists = (ref?: ModelRef) => !!ref && this.models.some((m) => m.id === ref.id && m.providerID === ref.providerID);
    const fallback = defaultModel ?? this.models[0];
    this.selectedModel = exists(saved) ? saved : fallback ? { id: fallback.id, providerID: fallback.providerID } : undefined;

    const savedAgent = this.ctx.globalState.get<string>(AGENT_KEY);
    // Even when the server exposes no agents, build/plan are built in: keep Build as the default.
    const fallbackAgent = (this.agents.find((a) => a.id === "build") ?? this.agents[0])?.id ?? "build";
    this.selectedAgent =
      this.agents.length === 0 ? (savedAgent ?? "build") : this.agents.some((a) => a.id === savedAgent) ? savedAgent : fallbackAgent;
  }

  selectModel(model: ModelRef): void {
    this.selectedModel = model;
    void this.ctx.globalState.update(MODEL_KEY, model);
    this.publish();
  }

  selectAgent(agent: string): void {
    this.selectedAgent = agent;
    void this.ctx.globalState.update(AGENT_KEY, agent);
    this.publish();
  }

  /** Re-fetch skills and commands; OpenCode registers plugin items only after a session exists. */
  async refresh(client: OpenCodeClient): Promise<void> {
    const [skills, commands] = await Promise.all([
      client.skills().catch((err: unknown) => {
        this.log(`[chat] failed to load skills: ${String(err)}`);
        return undefined;
      }),
      client.commands().catch((err: unknown) => {
        this.log(`[chat] failed to load commands: ${String(err)}`);
        return undefined;
      }),
    ]);
    const safeSkills = skills ? normalizeList(skills, normalizeSkill) : undefined;
    const safeCommands = commands ? normalizeList(commands, normalizeCommand) : undefined;
    let changed = false;
    if (
      safeSkills &&
      !sameList(
        safeSkills.map((s) => `${s.id}\u0000${s.name}\u0000${s.description ?? ""}`),
        this.skills.map((s) => `${s.id}\u0000${s.name}\u0000${s.description ?? ""}`),
      )
    ) {
      this.skills = safeSkills;
      changed = true;
    }
    if (
      safeCommands &&
      !sameList(
        safeCommands.map((c) => `${c.name}\u0000${c.description ?? ""}`),
        this.commands.map((c) => `${c.name}\u0000${c.description ?? ""}`),
      )
    ) {
      this.commands = safeCommands;
      changed = true;
    }
    if (changed && this.canPost()) this.publish();
  }

  /** Local commands shadow a server command with the same name, so `/fork` keeps our semantics. */
  private publishedCommands(): CommandInfo[] {
    const server = this.commands.filter((c) => c.name !== "fork");
    return [
      ...server.map(({ name, description }) => ({ name, description })),
      ...LOCAL_COMMANDS.map(({ name, description }) => ({ name, description })),
    ];
  }

  publish(): void {
    this.post({
      type: "catalog",
      models: this.models,
      agents: this.agents,
      skills: this.skills.map(({ id, name, description }) => ({ id, name, description })),
      commands: this.publishedCommands(),
      selectedModel: this.selectedModel,
      selectedAgent: this.selectedAgent,
    });
  }
}
