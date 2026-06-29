import { Logger } from "@subsquid/logger";
import { GearApi } from "@gear-js/api";
import { ProcessorContext } from "../processor";

export abstract class BaseHandler {
  protected events: string[] = [];
  protected userMessageSentProgramIds: string[] = [];
  protected messageQueuedProgramIds: string[] = [];
  protected ctx: ProcessorContext;
  protected logger: Logger;

  getEvents(): string[] {
    return this.events;
  }

  getUserMessageSentProgramIds(): string[] {
    return this.userMessageSentProgramIds;
  }

  getMessageQueuedProgramIds(): string[] {
    return this.messageQueuedProgramIds;
  }

  async init(_api?: GearApi): Promise<void> {
    return Promise.resolve();
  }

  clear(): void {}

  async process(ctx: ProcessorContext): Promise<void> {
    this.ctx = ctx;
    this.logger = ctx.log;
    this.clear();
  }

  abstract save(): Promise<void>;
}
