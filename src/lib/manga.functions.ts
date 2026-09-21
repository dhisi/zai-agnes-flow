import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { parseScript } from "./script";
import {
  buildCharacterBible,
  normalizeLeadCharacter,
  writePrompts,
  renderPanel,
} from "./manga.server";
import { engineStatus } from "./zai.server";
import { withRun, KilledError } from "./kill-switch.server";

const SegmentSchema = z.object({
  index: z.number(),
  start: z.number(),
  end: z.number(),
  text: z.string(),
});

export const analyzeScript = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        script: z.string().min(5),
        /** A sheet written by the user. When given, it REPLACES the auto one. */
        manualBible: z.string().optional(),
        runAt: z.number().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    // Hanging up (Insta Kill, refresh, closed tab) aborts the upstream work
    // right away, so the API key it holds is free for the next job.
    const signal = getRequest().signal;
    return withRun(data.runAt, async () => {
    const segments = parseScript(data.script);
    if (segments.length === 0) {
      throw new Error("No timestamps found. Each line needs a time like 0:00, (0:00) or [0:00].");
    }
    // A user-written sheet is authoritative: no text call, no model rewrite —
    // exactly the lines the user typed are used as the appearance lock.
    const manual = (data.manualBible ?? "").trim();
    const bible = manual.length > 5
      ? normalizeLeadCharacter(manual.slice(0, 6000))
      : await buildCharacterBible(data.script);
    return { segments, bible, manual: manual.length > 5, engine: engineStatus() };
    }, signal);
  });

/**
 * One storyboard pass.
 *
 * The model is handed the ENTIRE script every time (no chunking, no chunk
 * briefs) and asked for the prompts of one range of line numbers, because the
 * answer — not the input — is what has a size ceiling. Continuity comes from
 * the model reading the whole story.
 */
export const promptsForRange = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        bible: z.string(),
        /** 1-based, inclusive. */
        from: z.number().int().min(1),
        to: z.number().int().min(1),
        segments: z.array(SegmentSchema).min(1),
        runAt: z.number().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    // Hanging up (Insta Kill, refresh, closed tab) aborts the upstream work
    // right away, so the API key it holds is free for the next job.
    const signal = getRequest().signal;
    return withRun(data.runAt, async () => {
      const prompts = await writePrompts(data.bible, data.segments, data.from, data.to);
      return { from: data.from, to: data.to, prompts, engine: engineStatus() };
    }, signal);
  });

export const renderImage = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        prompt: z.string().min(5),
        seed: z.number().int(),
        bible: z.string().optional(),
        line: z.string().optional(),
        timestamp: z.string().optional(),
        slot: z.number().int().min(0).default(0),
        continuity: z.string().max(400).optional(),
        runAt: z.number().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    // Hanging up (Insta Kill, refresh, closed tab) aborts the upstream work
    // right away, so the API key it holds is free for the next job.
    const signal = getRequest().signal;
    return withRun(data.runAt, async () => {
    const { url, prompt, rewritten } = await renderPanel(
      data.prompt,
      data.seed,
      data.slot,
      data.bible,
      data.line,
      data.timestamp,
      data.continuity,
    );
    return { url, prompt, rewritten };
    }, signal);
  });

/**
 * Renders several panels in one round trip. Failures are reported per item so
 * one bad panel never fails the group.
 */
export const renderBatch = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        bible: z.string().optional(),
        jobs: z
          .array(
            z.object({
              index: z.number().int(),
              prompt: z.string().min(5),
              seed: z.number().int(),
              slot: z.number().int().min(0).default(0),
              line: z.string().optional(),
              timestamp: z.string().optional(),
              continuity: z.string().max(400).optional(),
            }),
          )
          .min(1)
          .max(10),
        runAt: z.number().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    // Hanging up (Insta Kill, refresh, closed tab) aborts the upstream work
    // right away, so the API key it holds is free for the next job.
    const signal = getRequest().signal;
    return withRun(data.runAt, async () => {
    const t0 = Date.now();
    const idx = data.jobs.map((j) => j.index).join(",");
    console.log(`[render] batch START panels ${idx}`);
    const results = await Promise.all(
      data.jobs.map(async (job) => {
        try {
          // renderPanel retries the FULL prompt across the whole key pool on
          // fresh seeds; it is never shortened, only softened on a refusal.

          const { url, prompt, rewritten } = await renderPanel(
            job.prompt,
            job.seed,
            job.slot,
            data.bible,
            job.line,
            job.timestamp,
            job.continuity,
          );
          return { index: job.index, url, prompt, rewritten };
        } catch (e) {
          // Insta Kill is cancellation for the WHOLE batch, never a set of
          // ordinary failed panels that the browser would then re-queue.
          if (e instanceof KilledError) throw e;
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`[render] panel ${job.index} failed: ${msg}`);
          return {
            index: job.index,
            url: null as string | null,
            error: msg,
          };
        }
      }),
    );
    const ok = results.filter((r) => r.url).length;
    console.log(
      `[render] batch DONE panels ${idx} in ${Date.now() - t0}ms: ${ok}/${results.length} rendered`,
    );
    return { results };
    }, signal);
  });
