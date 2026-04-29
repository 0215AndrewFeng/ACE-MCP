import { APP_VERSION } from "../../version.js";

export interface ResponseEnvelope<TData, TRequest = Record<string, unknown>, TStats = Record<string, unknown>> {
  [key: string]: unknown;
  data: TData;
  meta: {
    generatedAt: string;
    ok: boolean;
    version: string;
  };
  notes: string[];
  request: TRequest;
  stats: TStats;
}

export function buildEnvelope<TData, TRequest = Record<string, unknown>, TStats = Record<string, unknown>>(
  request: TRequest,
  data: TData,
  stats: TStats,
  notes: string[] = [],
): ResponseEnvelope<TData, TRequest, TStats> {
  return {
    data,
    meta: {
      generatedAt: new Date().toISOString(),
      ok: true,
      version: APP_VERSION,
    },
    notes,
    request,
    stats,
  };
}

export function asStructuredToolResponse<T>(payload: T): {
  content: Array<{ text: string; type: "text" }>;
  structuredContent: T;
} {
  return {
    content: [
      {
        text: JSON.stringify(payload, null, 2),
        type: "text",
      },
    ],
    structuredContent: payload,
  };
}
