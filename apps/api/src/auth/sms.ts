/**
 * SMS delivery.
 *
 * India requires DLT registration for transactional SMS — entity, header, and
 * per-template approval with the telecom regulator, routinely two to four
 * weeks and outside our control (Arch §07, §15). OTP is the front door to
 * every persona, so this sits on the critical path.
 *
 * The interface exists now so the provider can be dropped in the day approval
 * lands, and so the documented fallback — manually-issued codes for assisted
 * pilot onboarding — is a real code path rather than a paragraph in a risk
 * register.
 */

export interface SmsSender {
  readonly name: string;
  send(to: string, message: string): Promise<void>;
}

/**
 * Development sender. Prints the code to the server log.
 *
 * Guarded twice: it refuses to construct when NODE_ENV is production, and the
 * factory below will not select it there either. A dev sender reachable in
 * production is an authentication bypass, not an inconvenience.
 */
export class LogSender implements SmsSender {
  readonly name = "log";

  constructor() {
    if (process.env["NODE_ENV"] === "production") {
      throw new Error("LogSender must never be used in production — it prints OTP codes");
    }
  }

  async send(to: string, message: string): Promise<void> {
    console.log(`\n  ┌─ SMS (dev) ─────────────────────────────`);
    console.log(`  │ to: ${to}`);
    console.log(`  │ ${message}`);
    console.log(`  └─────────────────────────────────────────\n`);
  }
}

/**
 * Assisted-onboarding sender for the DLT fallback: the code is not sent at
 * all, it is read out by whoever is sitting with the committee. The challenge
 * row records channel = 'manual', so the trail shows how the code travelled.
 */
export class ManualSender implements SmsSender {
  readonly name = "manual";
  async send(): Promise<void> {
    // Intentionally nothing. The operator reads the code from the admin view.
  }
}

export class UnconfiguredSender implements SmsSender {
  readonly name = "unconfigured";
  async send(): Promise<void> {
    throw new Error(
      "No SMS provider is configured. Set SMS_PROVIDER_KEY once DLT registration clears, " +
        "or set OTP_CHANNEL=manual for assisted onboarding.",
    );
  }
}

export function senderFromEnv(): SmsSender {
  const channel = process.env["OTP_CHANNEL"];
  const isProduction = process.env["NODE_ENV"] === "production";

  if (channel === "manual") return new ManualSender();
  if (!isProduction && (channel === "log" || !process.env["SMS_PROVIDER_KEY"])) {
    return new LogSender();
  }
  if (process.env["SMS_PROVIDER_KEY"]) {
    // The DLT-registered provider lands here once approval clears. Templates
    // are versioned in the template registry and carry their DLT ids, which is
    // why the text cannot be composed freely at this layer (Arch §09).
    return new UnconfiguredSender();
  }
  return new UnconfiguredSender();
}

/**
 * The OTP message. Once DLT-approved, this text is fixed by the registered
 * template and may not vary — which is why it lives in one place.
 */
export function otpMessage(code: string, language: "en" | "hi"): string {
  return language === "hi"
    ? `SocietyRecord में साइन इन करने के लिए कोड: ${code}. 5 मिनट में समाप्त. किसी को न बताएं.`
    : `Your SocietyRecord sign-in code is ${code}. It expires in 5 minutes. Do not share it.`;
}
