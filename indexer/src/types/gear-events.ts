import { Call, Event, Extrinsic } from "../processor";

export interface GearRunExtrinsic extends Extrinsic {
  readonly hash: `0x${string}`;
}

export type UserMessageSentEvent = Omit<Event, "args" | "extrinsic"> & {
  args: UserMessageSentArgs;
  extrinsic: GearRunExtrinsic;
};

export interface UserMessageSentArgs {
  readonly message: {
    readonly id: `0x${string}`;
    readonly source: `0x${string}`;
    readonly destination: `0x${string}`;
    readonly payload: `0x${string}`;
    readonly value: string;
    readonly details?: UserMessageSentDetails;
  };
}

export interface UserMessageSentDetails {
  readonly code: {
    readonly __kind: "Success" | "Error";
  };
  readonly to: `0x${string}`;
}

export interface MessageQueuedExtrinsic extends Extrinsic {
  readonly hash: `0x${string}`;
}

export interface MessageQueuedCall extends Omit<Call, "args"> {
  readonly args: {
    readonly destination: `0x${string}`;
    readonly payload: `0x${string}`;
    readonly gasLimit: string;
    readonly value: string;
  };
}

export type MessageQueuedEvent = Omit<Event, "args" | "extrinsic" | "call"> & {
  args: MessageQueuedArgs;
  extrinsic: MessageQueuedExtrinsic;
  call: MessageQueuedCall;
};

export interface MessageQueuedArgs {
  readonly id: string;
  readonly source: string;
  readonly destination: string;
  readonly entry: "Init" | "Handle" | "Reply";
}

export type DecodedSailsEvent<T = unknown> = {
  programId: `0x${string}`;
  service: string;
  name: string;
  payload: T;
  blockHeight: number;
  blockTimestamp: Date;
};
