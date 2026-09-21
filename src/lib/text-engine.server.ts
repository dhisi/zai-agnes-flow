/**
 * The ONLY text engine in this app: Z.ai GLM (glm-4.5-flash, free tier).
 */

import { zaiChat } from "./zai.server";

export async function textChat(
  system: string,
  user: string,
  opts: {
    temperature?: number;
    maxOutputTokens?: number;
    timeoutMs?: number;
    attempts?: number;
  } = {},
): Promise<string> {
  return zaiChat(user, { system, ...opts });
}
