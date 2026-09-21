import { createServerFn } from "@tanstack/react-start";

/**
 * Stops every generation run the server has accepted so far — including work
 * left behind by a page that was refreshed or closed.
 */
export const instaKill = createServerFn({ method: "POST" }).handler(async () => {
  const { killAllRuns } = await import("./kill-switch.server");
  const result = killAllRuns();
  return { ...result, at: Date.now() };
});
