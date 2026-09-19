import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { env, platform } from "node:process";

const DEFAULT_KEYCHAIN_SERVICE = "com.turnturn.anthropic-api-key";
const MAX_CREDENTIAL_BYTES = 8 * 1024;

export interface CredentialCommandResult {
  readonly stdout: string;
}

export type CredentialCommandRunner = (executable: string, args: readonly string[]) => Promise<CredentialCommandResult>;

export interface AnthropicCredentialOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly platform?: string;
  readonly run?: CredentialCommandRunner;
}

export async function resolveAnthropicApiKey(options: AnthropicCredentialOptions = {}): Promise<string> {
  const environment = options.environment ?? env;
  const direct = environment.ANTHROPIC_API_KEY ?? environment.TURNTURN_API_KEY;
  if (direct !== undefined && direct.trim().length > 0) return direct.trim();

  const helper = environment.ANTHROPIC_API_KEY_HELPER;
  if (helper !== undefined) {
    if (!isAbsolute(helper)) throw new Error("ANTHROPIC_API_KEY_HELPER must be an absolute executable path");
    return readCredential(options.run ?? runCredentialCommand, helper, []);
  }

  if ((options.platform ?? platform) !== "darwin") {
    throw new Error("Anthropic credentials are not configured; set ANTHROPIC_API_KEY_HELPER or ANTHROPIC_API_KEY");
  }
  const account = environment.TURNTURN_ANTHROPIC_KEYCHAIN_ACCOUNT ?? environment.USER;
  if (account === undefined || account.length === 0) {
    throw new Error("TURNTURN_ANTHROPIC_KEYCHAIN_ACCOUNT is required when USER is unavailable");
  }
  const service = environment.TURNTURN_ANTHROPIC_KEYCHAIN_SERVICE ?? DEFAULT_KEYCHAIN_SERVICE;
  return readCredential(options.run ?? runCredentialCommand, "/usr/bin/security", [
    "find-generic-password",
    "-a",
    account,
    "-s",
    service,
    "-w",
  ]);
}

async function readCredential(
  run: CredentialCommandRunner,
  executable: string,
  args: readonly string[],
): Promise<string> {
  let result: CredentialCommandResult;
  try {
    result = await run(executable, args);
  } catch {
    throw new Error(
      "Could not load the Anthropic credential. Run scripts/setup-anthropic-keychain.sh or configure ANTHROPIC_API_KEY_HELPER.",
    );
  }
  if (Buffer.byteLength(result.stdout, "utf8") > MAX_CREDENTIAL_BYTES) {
    throw new Error("Anthropic credential helper returned too much data");
  }
  const credential = result.stdout.trim();
  if (credential.length === 0 || credential.includes("\n") || credential.includes("\r")) {
    throw new Error("Anthropic credential helper returned an invalid value");
  }
  return credential;
}

function runCredentialCommand(executable: string, args: readonly string[]): Promise<CredentialCommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...args],
      { encoding: "utf8", maxBuffer: MAX_CREDENTIAL_BYTES + 1, timeout: 10_000, windowsHide: true },
      (error, stdout) => {
        if (error !== null) reject(error);
        else resolve({ stdout });
      },
    );
  });
}
