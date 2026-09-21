import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/proxy-image")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url).searchParams.get("url");
        // Only the image provider's own output hosts may be proxied.
        if (
          !url ||
          // The provider serves finished renders from agnes-ai.space as well as
          // agnes-ai.com, so both output hosts are allowed.
          !/^https:\/\/[a-z0-9.-]*(agnes-ai\.com|agnes-ai\.space|storage\.googleapis\.com|r2\.dev)\//i.test(
            url,
          )
        ) {
          return new Response("Bad url", { status: 400 });
        }
        const upstream = await fetch(url);
        if (!upstream.ok) return new Response("Upstream error", { status: 502 });
        return new Response(upstream.body, {
          headers: {
            "Content-Type": upstream.headers.get("content-type") ?? "image/png",
            "Cache-Control": "public, max-age=86400",
            "Access-Control-Allow-Origin": "*",
          },
        });
      },
    },
  },
});
