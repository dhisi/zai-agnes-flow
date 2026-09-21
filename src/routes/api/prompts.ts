import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { writePrompts } from "@/lib/manga.server";
import { withRun } from "@/lib/kill-switch.server";

const Input = z
  .object({
    bible: z.string().max(10_000),
    from: z.number().int().min(1),
    to: z.number().int().min(1),
    lines: z.array(z.number().int().min(1)).min(1).max(120).optional(),
    segments: z
      .array(
        z.object({
          index: z.number().int(),
          start: z.number(),
          end: z.number(),
          text: z.string().max(20_000),
        }),
      )
      .min(1)
      .max(10_000),
    runAt: z.number().optional(),
  })
  .refine(
    (value) =>
      value.to >= value.from &&
      (value.lines
        ? value.lines.every((line) => line >= value.from && line <= value.to)
        : value.to - value.from < 120),
    {
    message: "Prompt range must contain 1 to 120 lines",
    },
  );

export const Route = createFileRoute("/api/prompts")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let input: z.infer<typeof Input>;
        try {
          input = Input.parse(await request.json());
        } catch (error) {
          const message = error instanceof Error ? error.message : "Invalid request";
          return Response.json({ error: message }, { status: 400 });
        }

        const encoder = new TextEncoder();
        let cleanup: (() => void) | undefined;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            let closed = false;
            const send = (event: string, data: unknown) => {
              if (closed) return;
              try {
                controller.enqueue(
                  encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
                );
              } catch {
                // The reader is gone (aborted/rejected stream): stop writing.
                closed = true;
              }
            };

            // Cleanup runs for every outcome — resolved, failed, rejected or
            // aborted — so no stream stays tracked with a live heartbeat.
            let heartbeat: ReturnType<typeof setInterval> | undefined;
            const finish = () => {
              if (heartbeat !== undefined) clearInterval(heartbeat);
              heartbeat = undefined;
              if (closed) return;
              closed = true;
              try {
                controller.close();
              } catch {
                /* already closed by the platform */
              }
            };

            // Flush response headers immediately, then keep the published
            // connection active while Z.ai streams its long answer upstream.
            send("started", { from: input.from, to: input.to });
            heartbeat = setInterval(() => send("heartbeat", { at: Date.now() }), 10_000);

            void withRun(
              input.runAt,
              () => writePrompts(input.bible, input.segments, input.from, input.to, input.lines),
              // The browser dropping this request (Insta Kill, refresh, closed
              // tab) aborts the upstream work at once, freeing the key.
              request.signal,
            )
              .then((prompts) => send("result", { prompts }))
              .catch((error) =>
                send("failure", {
                  error: error instanceof Error ? error.message : String(error),
                }),
              )
              .then(finish, finish);

            cleanup = finish;
          },
          cancel() {
            cleanup?.();
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          },
        });
      },
    },
  },
});