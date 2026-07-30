import { Container } from "@cloudflare/containers";
import type { Env } from "./env";

export const RUN_TOKEN_HEADER = "x-heddle-run-token";

export class HeddleEngine extends Container<Env> {
  defaultPort = 4319;

  sleepAfter = "2m";

  enableInternet = false;

  override async fetch(request: Request): Promise<Response> {
    const token = request.headers.get(RUN_TOKEN_HEADER) ?? "";

    this.allowedHosts = this.env.PROXY_HOST ? [this.env.PROXY_HOST] : [];

    await this.startAndWaitForPorts({
      startOptions: {
        envVars: {
          OPENAI_BASE_URL: this.env.PROXY_URL,
          OPENAI_API_KEY: token,
        },
        labels: { component: "heddle-engine" },
      },
      cancellationOptions: {
        instanceGetTimeoutMS: 15_000,
        portReadyTimeoutMS: 20_000,
      },
    });

    const forwarded = new Request(request);
    forwarded.headers.delete(RUN_TOKEN_HEADER);

    return this.containerFetch(forwarded);
  }

  override onError(error: unknown): unknown {
    console.error("heddle engine container error", error);
    return error;
  }
}
