export type RecoverableStatus = "waiting" | "prompting" | "drawing" | "done" | "error";

/** In-flight browser work cannot survive a refresh, so make it safely runnable again. */
export function recoverInterruptedShots<
  T extends { status: RecoverableStatus; error?: string | undefined },
>(shots: T[]): T[] {
  return shots.map((shot) => {
    if (shot.status !== "prompting" && shot.status !== "drawing") return shot;
    const next = { ...shot, status: "waiting" as const };
    delete next.error;
    return next;
  });
}