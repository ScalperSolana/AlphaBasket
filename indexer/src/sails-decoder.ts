import { isHex } from "@subsquid/util-internal-hex";
import { existsSync, readFileSync } from "node:fs";
import { getFnNamePrefix, getServiceNamePrefix, Sails } from "sails-js";
import { SailsIdlParser } from "sails-js-parser";
import { MessageQueuedEvent, UserMessageSentEvent } from "./types/gear-events";

interface Message {
  service: string;
  method: string;
}

interface InputMessage<T> extends Message {
  params: T;
}

interface OutputMessage<T> extends Message {
  payload: T;
}

type EventMessage<T> = OutputMessage<T>;

export class SailsDecoder {
  constructor(private readonly program: Sails) {}

  static async new(idlPath: string) {
    if (!existsSync(idlPath)) {
      throw new Error(`IDL file does not exist: ${idlPath}`);
    }

    const idlContent = readFileSync(idlPath, "utf8");
    const parser = await SailsIdlParser.new();
    const sails = new Sails(parser);
    sails.parseIdl(idlContent);

    return new SailsDecoder(sails);
  }

  service(data: string): string {
    if (!isHex(data)) {
      throw new Error(`Invalid hex string: ${data}`);
    }

    return getServiceNamePrefix(data as `0x${string}`);
  }

  method(data: string): string {
    if (!isHex(data)) {
      throw new Error(`Invalid hex string: ${data}`);
    }

    return getFnNamePrefix(data as `0x${string}`);
  }

  decodeInput<T>({
    call: {
      args: { payload },
    },
  }: MessageQueuedEvent): InputMessage<T> {
    const service = this.service(payload);
    const method = this.method(payload);
    const params =
      this.program.services[service].functions[method].decodePayload<T>(
        payload
      );

    return { service, method, params };
  }

  decodeOutput<T>({
    args: {
      message: { payload },
    },
  }: UserMessageSentEvent): OutputMessage<T> {
    const service = this.service(payload);
    const method = this.method(payload);
    const result =
      this.program.services[service].functions[method].decodeResult<T>(payload);

    return {
      service,
      method,
      payload: result,
    };
  }

  decodeEvent<T>({
    args: {
      message: { payload },
    },
  }: UserMessageSentEvent): EventMessage<T> | null {
    const service = this.service(payload);
    const method = this.method(payload);
    const serviceDef = this.program.services[service];
    if (!serviceDef?.events) {
      return null;
    }

    const eventDef = serviceDef.events[method];
    if (!eventDef) {
      return null;
    }

    const result = eventDef.decode(payload);

    return {
      service,
      method,
      payload: result,
    };
  }
}
