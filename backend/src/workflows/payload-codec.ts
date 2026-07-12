export type WorkflowValue =
  | null
  | string
  | boolean
  | bigint
  | readonly WorkflowValue[]
  | { readonly [key: string]: WorkflowValue };

export interface EncodedWorkflowPayload {
  readonly encoding: "alphabasket/workflow-json-v1";
  readonly data: string;
}

type EncodedNode =
  | readonly ["null"]
  | readonly ["string", string]
  | readonly ["boolean", boolean]
  | readonly ["bigint", string]
  | readonly ["array", readonly EncodedNode[]]
  | readonly ["object", readonly (readonly [string, EncodedNode])[]];

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertSafeObjectKey(key: string): void {
  if (key === "__proto__" || key === "constructor" || key === "prototype") {
    throw new TypeError(`unsafe workflow object key: ${key}`);
  }
}

function encodeNode(value: WorkflowValue): EncodedNode {
  if (value === null) {
    return ["null"];
  }
  if (typeof value === "string") {
    return ["string", value];
  }
  if (typeof value === "boolean") {
    return ["boolean", value];
  }
  if (typeof value === "bigint") {
    return ["bigint", value.toString(10)];
  }
  if (Array.isArray(value)) {
    return ["array", value.map(encodeNode)];
  }

  if (
    typeof value !== "object" ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new TypeError(
      "workflow payloads support only null, strings, booleans, bigints, arrays, and plain objects",
    );
  }

  return [
    "object",
    Object.entries(value)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, child]) => {
        assertSafeObjectKey(key);
        return [key, encodeNode(child)] as const;
      }),
  ];
}

function isPair(value: unknown): value is readonly unknown[] {
  return Array.isArray(value) && value.length >= 1;
}

function decodeNode(node: unknown): WorkflowValue {
  if (!isPair(node) || typeof node[0] !== "string") {
    throw new TypeError("invalid workflow payload node");
  }
  switch (node[0]) {
    case "null":
      if (node.length !== 1) throw new TypeError("invalid null node");
      return null;
    case "string":
      if (node.length !== 2 || typeof node[1] !== "string") {
        throw new TypeError("invalid string node");
      }
      return node[1];
    case "boolean":
      if (node.length !== 2 || typeof node[1] !== "boolean") {
        throw new TypeError("invalid boolean node");
      }
      return node[1];
    case "bigint":
      if (
        node.length !== 2 ||
        typeof node[1] !== "string" ||
        !/^-?(0|[1-9][0-9]*)$/u.test(node[1])
      ) {
        throw new TypeError("invalid bigint node");
      }
      return BigInt(node[1]);
    case "array":
      if (node.length !== 2 || !Array.isArray(node[1])) {
        throw new TypeError("invalid array node");
      }
      return node[1].map(decodeNode);
    case "object": {
      if (node.length !== 2 || !Array.isArray(node[1])) {
        throw new TypeError("invalid object node");
      }
      const result = Object.create(null) as Record<string, WorkflowValue>;
      for (const entry of node[1]) {
        if (
          !Array.isArray(entry) ||
          entry.length !== 2 ||
          typeof entry[0] !== "string" ||
          Object.hasOwn(result, entry[0])
        ) {
          throw new TypeError("invalid workflow object entry");
        }
        assertSafeObjectKey(entry[0]);
        result[entry[0]] = decodeNode(entry[1]);
      }
      return result;
    }
    default:
      throw new TypeError(`unknown workflow payload tag: ${node[0]}`);
  }
}

export function encodeWorkflowPayload(value: WorkflowValue): EncodedWorkflowPayload {
  return {
    encoding: "alphabasket/workflow-json-v1",
    data: JSON.stringify(encodeNode(value)),
  };
}

export function decodeWorkflowPayload(payload: EncodedWorkflowPayload): WorkflowValue {
  if (payload.encoding !== "alphabasket/workflow-json-v1") {
    throw new TypeError(`unsupported workflow payload encoding: ${String(payload.encoding)}`);
  }
  return decodeNode(JSON.parse(payload.data) as unknown);
}
