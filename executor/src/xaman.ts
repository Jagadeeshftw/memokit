/**
 * Xaman (formerly XUMM) payloads: push an unsigned XRPL Payment to a phone and wait for it.
 *
 * Xaman is how most XRPL users hold a key, and it is the difference between memokit being
 * usable by somebody with a wallet and usable by somebody with a seed in a file. The flow is
 * three calls: create a payload, show the user its QR or deep link, poll until they sign.
 *
 * **Credentials are required and are not optional-with-a-fallback.** An API key and secret
 * come from the Xaman developer console; there is no anonymous mode. Everything up to this
 * point works without them -- `buildUnsignedPayment` and the QR render a transaction any wallet
 * can take -- so the check below is a hard stop with a precise message, not a silent downgrade.
 */
export const XAMAN_API = "https://xumm.app/api/v1/platform";

export class XamanNotConfigured extends Error {
  constructor(readonly missing: string[]) {
    super(
      `Xaman is not configured. Missing: ${missing.join(", ")}.\n` +
        `Create an application at https://apps.xaman.dev and put the credentials in .env:\n` +
        missing.map((m) => `  ${m}=...`).join("\n") +
        `\n\nEverything except the Xaman push works without them: the unsigned transaction and ` +
        `its QR are produced either way, and any XRPL wallet can sign them.`,
    );
    this.name = "XamanNotConfigured";
  }
}

export interface XamanCredentials {
  apiKey: string;
  apiSecret: string;
}

/** Reads the credentials, or says exactly which one is missing. */
export function xamanCredentials(env = process.env): XamanCredentials {
  const missing: string[] = [];
  if (!env.XAMAN_API_KEY) missing.push("XAMAN_API_KEY");
  if (!env.XAMAN_API_SECRET) missing.push("XAMAN_API_SECRET");
  if (missing.length > 0) throw new XamanNotConfigured(missing);
  return { apiKey: env.XAMAN_API_KEY!, apiSecret: env.XAMAN_API_SECRET! };
}

export function isXamanConfigured(env = process.env): boolean {
  return Boolean(env.XAMAN_API_KEY && env.XAMAN_API_SECRET);
}

export interface XamanPayload {
  uuid: string;
  /** Open this on the phone that holds the key. */
  deepLink: string;
  /** Xaman's own QR, hosted. The CLI also renders one locally so nothing has to be fetched. */
  qrPng: string;
  /** Websocket that pushes the outcome, for a caller that would rather not poll. */
  websocket: string;
}

export interface XamanResolution {
  signed: boolean;
  /** The XRPL transaction hash, once signed and submitted by Xaman. */
  txid: string | null;
  /** The account that actually signed, which is worth checking against the one asked for. */
  account: string | null;
  cancelled: boolean;
  expired: boolean;
}

export class XamanClient {
  constructor(private readonly credentials: XamanCredentials) {}

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "X-API-Key": this.credentials.apiKey,
      "X-API-Secret": this.credentials.apiSecret,
    };
  }

  /**
   * Create a payload for an unsigned transaction.
   *
   * `submit: true` has Xaman push the signed transaction to XRPL itself, which is what makes
   * the round trip a single scan. `expire` is in minutes and is deliberately short: the memo
   * commits to an account nonce, and a payment signed an hour later may find that nonce used.
   */
  async create(
    transaction: Record<string, unknown>,
    options: { expireMinutes?: number; instruction?: string; returnUrl?: string } = {},
  ): Promise<XamanPayload> {
    const res = await fetch(`${XAMAN_API}/payload`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        txjson: transaction,
        options: {
          submit: true,
          expire: options.expireMinutes ?? 10,
          ...(options.returnUrl ? { return_url: { web: options.returnUrl } } : {}),
        },
        ...(options.instruction ? { custom_meta: { instruction: options.instruction } } : {}),
      }),
    });
    const body = (await res.json()) as {
      uuid?: string;
      next?: { always?: string };
      refs?: { qr_png?: string; websocket_status?: string };
      error?: unknown;
    };
    if (!res.ok || !body.uuid) {
      throw new Error(`Xaman refused the payload (HTTP ${res.status}): ${JSON.stringify(body).slice(0, 300)}`);
    }
    return {
      uuid: body.uuid,
      deepLink: body.next?.always ?? `https://xaman.app/sign/${body.uuid}`,
      qrPng: body.refs?.qr_png ?? "",
      websocket: body.refs?.websocket_status ?? "",
    };
  }

  async get(uuid: string): Promise<XamanResolution> {
    const res = await fetch(`${XAMAN_API}/payload/${uuid}`, { headers: this.headers() });
    const body = (await res.json()) as {
      meta?: { signed?: boolean; cancelled?: boolean; expired?: boolean; resolved?: boolean };
      response?: { txid?: string | null; account?: string | null };
    };
    if (!res.ok) throw new Error(`Xaman payload lookup failed: HTTP ${res.status}`);
    return {
      signed: body.meta?.signed === true,
      cancelled: body.meta?.cancelled === true,
      expired: body.meta?.expired === true,
      txid: body.response?.txid ?? null,
      account: body.response?.account ?? null,
    };
  }

  /** Poll until the user signs, cancels, or the payload expires. */
  async wait(
    uuid: string,
    options: { deadlineMs?: number; intervalMs?: number; onPoll?: (r: XamanResolution) => void } = {},
  ): Promise<XamanResolution> {
    const deadline = options.deadlineMs ?? Date.now() + 10 * 60_000;
    const interval = options.intervalMs ?? 3_000;
    for (;;) {
      const resolution = await this.get(uuid);
      options.onPoll?.(resolution);
      if (resolution.signed || resolution.cancelled || resolution.expired) return resolution;
      if (Date.now() > deadline) return resolution;
      await new Promise((r) => setTimeout(r, interval));
    }
  }
}
