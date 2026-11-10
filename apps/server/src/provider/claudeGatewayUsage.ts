import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

const Settings = Schema.Struct({
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const decodeSettings = Schema.decodeEffect(Schema.fromJsonString(Settings));
const Window = Schema.Struct({
  utilization: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  resets_at: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T/)),
});
const Usage = Schema.Struct({
  five_hour: Schema.NullOr(Window),
  seven_day: Schema.NullOr(Window),
});

export const resolveClaudeGatewayUsage = Effect.fn("resolveClaudeGatewayUsage")(function* (
  configDir: string,
  environment: NodeJS.ProcessEnv,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fs.readFileString(path.join(configDir, "settings.json")).pipe(
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed("{}") : Effect.fail(error),
    }),
  );
  const settings = yield* decodeSettings(text);
  const env = {
    ...settings.env,
    ...Object.fromEntries(Object.entries(environment).filter(([, value]) => value !== undefined)),
  };
  const usageUrl = env.T3_CLAUDE_USAGE_URL?.trim();
  if (!usageUrl) return undefined;
  const base = URL.parse(env.ANTHROPIC_BASE_URL?.trim() ?? "");
  const usage = URL.parse(usageUrl);
  const token = (env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY)?.trim();
  if (
    !base ||
    !usage ||
    !token ||
    /[\r\n]/.test(token) ||
    !["https:", "http:"].includes(base.protocol) ||
    base.hostname === "api.anthropic.com" ||
    usage.href !== new URL("api/oauth/usage", base.href.replace(/\/?$/, "/")).href ||
    usage.username ||
    usage.password ||
    base.username ||
    base.password
  )
    return null;
  return { url: usage.href, token };
});

export const readClaudeGatewayUsage = Effect.fn("readClaudeGatewayUsage")(
  function* (gateway: { readonly url: string; readonly token: string } | null) {
    if (!gateway) return undefined;
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get(gateway.url).pipe(
        HttpClientRequest.setHeader("authorization", `Bearer ${gateway.token}`),
      ),
    );
    const body = yield* HttpClientResponse.schemaBodyJson(Usage)(
      yield* HttpClientResponse.filterStatusOk(response),
    );
    if (
      [body.five_hour, body.seven_day].some(
        (window) => window && !Number.isFinite(Date.parse(window.resets_at)),
      )
    )
      return undefined;
    return { rate_limits_available: true, rate_limits: body };
  },
  Effect.timeout("10 seconds"),
  Effect.orElseSucceed(() => undefined),
);
