import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vite-plus/test";
import { readClaudeGatewayUsage, resolveClaudeGatewayUsage } from "./claudeGatewayUsage.ts";
import { claudeUsageResponseToLimits } from "./claudeUsageLimits.ts";

it.layer(NodeServices.layer)("Claude gateway usage", (it) => {
  it.effect("requires opt-in and matching custom origin without replacing credentials", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const settings = {
        env: { ANTHROPIC_BASE_URL: "https://proxy.example", ANTHROPIC_AUTH_TOKEN: "gateway-token" },
      };
      yield* fs.writeFileString(path.join(home, "settings.json"), JSON.stringify(settings));
      expect(yield* resolveClaudeGatewayUsage(home, {})).toBeUndefined();
      const env = { T3_CLAUDE_USAGE_URL: "https://proxy.example/api/oauth/usage" };
      expect(yield* resolveClaudeGatewayUsage(home, env)).toEqual({
        url: env.T3_CLAUDE_USAGE_URL,
        token: "gateway-token",
      });
      expect(
        yield* resolveClaudeGatewayUsage(home, {
          ...env,
          ANTHROPIC_BASE_URL: "https://api.anthropic.com",
        }),
      ).toBeUndefined();
      expect(
        yield* resolveClaudeGatewayUsage(home, {
          ...env,
          T3_CLAUDE_USAGE_URL: "https://other.example/api/oauth/usage",
        }),
      ).toBeNull();
      expect(
        yield* resolveClaudeGatewayUsage(home, { ...env, ANTHROPIC_AUTH_TOKEN: "instance-token" }),
      ).toEqual({ url: env.T3_CLAUDE_USAGE_URL, token: "instance-token" });
    }),
  );

  it.effect("maps authenticated pooled windows into T3 without native credits or spend", () =>
    Effect.gen(function* () {
      const gateway = { url: "https://proxy.example/api/oauth/usage", token: "gateway-token" };
      const client = HttpClient.make((request) => {
        expect(request.url).toBe(gateway.url);
        expect(request.method).toBe("GET");
        expect(request.headers.authorization).toBe("Bearer gateway-token");
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              five_hour: { utilization: 50, resets_at: "2026-11-11T00:00:00Z" },
              seven_day: null,
              cedar_ember: { eligible: true, grants: [{ resets_left: 99 }] },
              extra_usage: { is_enabled: true, utilization: 90 },
            }),
          ),
        );
      });
      const response = yield* readClaudeGatewayUsage(gateway).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      expect(response).toBeDefined();
      const { limits } = claudeUsageResponseToLimits({
        response: response!,
        checkedAt: "2026-11-10T00:00:00Z",
      });
      expect(limits.windows).toEqual([
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          windowDurationMins: 300,
          usedPercent: 50,
          resetsAt: "2026-11-11T00:00:00.000Z",
        },
      ]);
      expect(limits.resetCredits).toBeUndefined();
    }),
  );

  it.effect("fails closed for undeployed, invalid, and unauthenticated responses", () =>
    Effect.gen(function* () {
      for (const [status, body] of [
        [404, {}],
        [401, {}],
        [
          200,
          { five_hour: { utilization: 101, resets_at: "2026-11-11T00:00:00Z" }, seven_day: null },
        ],
        [200, {}],
      ] as const) {
        const client = HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body, { status }))),
        );
        expect(
          yield* readClaudeGatewayUsage({
            url: "https://proxy.example/api/oauth/usage",
            token: "gateway-token",
          }).pipe(Effect.provideService(HttpClient.HttpClient, client)),
        ).toBeUndefined();
      }
    }),
  );
});
