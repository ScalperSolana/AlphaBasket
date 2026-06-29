import { createHash } from "node:crypto";
import { config } from "../config";

const PUBLIC_ID_PREFIX = "agent";
const PUBLIC_ID_LENGTH = 12;

const normalizeActorId = (address: string): string => address.trim().toLowerCase();

export const getAgentPublicId = (address: string): string => {
  const digest = createHash("sha256")
    .update(config.agentPublicIdSalt)
    .update(":")
    .update(normalizeActorId(address))
    .digest("base64url")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase();

  return `${PUBLIC_ID_PREFIX}-${digest.slice(0, PUBLIC_ID_LENGTH)}`;
};
