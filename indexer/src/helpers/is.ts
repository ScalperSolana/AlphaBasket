import { Event } from "../processor";
import { MessageQueuedEvent, UserMessageSentEvent } from "../types/gear-events";

export function isUserMessageSentEvent(
  event: Event
): event is UserMessageSentEvent {
  return event.name === "Gear.UserMessageSent";
}

export function isMessageQueuedEvent(event: Event): event is MessageQueuedEvent {
  return event.name === "Gear.MessageQueued";
}

export function isSailsEvent(event: UserMessageSentEvent): boolean {
  return !Boolean(event.args.message.details);
}
