// Shared Urbicana banner: the OPENCLAW wordmark, with a short startup
// animation on rich interactive terminals.
// Used by the wizard flows (doctor/onboard/configure) and the foreground
// gateway run; non-TTY and CI paths always get the plain static banner.
import { restoreTerminalState } from "../../packages/terminal-core/src/restore.js";
import { isRich, theme } from "../../packages/terminal-core/src/theme.js";
import type { RuntimeEnv } from "../runtime.js";

const WORDMARK_ART = [
  "█▀▀▀█ █▀▀▀█ █▀▀▀▀ █▄  █ █▀▀▀▀ █     █▀▀▀█ █   █",
  "█   █ █▀▀▀▀ █▀▀▀  █ ▀▄█ █     █     █▀▀▀█ █▄▀▄█",
  "▀▀▀▀▀ ▀     ▀▀▀▀▀ ▀   ▀ ▀▀▀▀▀ ▀▀▀▀▀ ▀   ▀ ▀   ▀",
] as const;
const BANNER_WIDTH = 48;
const ROWS = WORDMARK_ART.length;

type ClawBannerOptions = {
  columns?: number;
  isTty?: boolean;
  rich?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Ends the animation on its static frame when parallel startup work settles. */
  settleWhen?: PromiseLike<unknown>;
  sleep?: (ms: number) => Promise<void>;
  write?: (chunk: string) => void;
};

export type ClawBannerResult = "static" | "completed" | "settled";

type CellTint = (col: number) => (text: string) => string;

const identityTint: (text: string) => string = (text) => text;

// Composes one banner frame. Tints run per glyph column so the wipe edge and
// shimmer band can cut through individual letters.
function composeFrame(params: { wordmarkTint?: CellTint }): string[] {
  const lines: string[] = [];
  for (let row = 0; row < ROWS; row++) {
    const wordmarkRow = WORDMARK_ART[row] ?? "";
    let out = "";
    for (let col = 0; col < wordmarkRow.length; col++) {
      const ch = wordmarkRow[col] ?? " ";
      out += ch === " " ? " " : (params.wordmarkTint?.(col) ?? identityTint)(ch);
    }
    lines.push(out.replace(/\s+$/, ""));
  }
  return lines;
}

function plainTitleLine(): string {
  return "OPENCLAW";
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

// One combined entrance: a left-to-right wipe reveals the color and a shimmer
// band sweeps the wordmark. The sequence ends on the exact static banner.
async function animateBanner(opts: {
  settleWhen?: PromiseLike<unknown>;
  sleep: (ms: number) => Promise<void>;
  write: (chunk: string) => void;
}): Promise<Exclude<ClawBannerResult, "static">> {
  const { settleWhen, sleep, write } = opts;
  let settleRequested = false;
  const settleSignal = settleWhen
    ? Promise.resolve(settleWhen).then(
        () => {
          settleRequested = true;
        },
        () => {
          settleRequested = true;
        },
      )
    : null;
  const pause = async (ms: number): Promise<boolean> => {
    if (!settleSignal) {
      await sleep(ms);
      return true;
    }
    await Promise.race([sleep(ms), settleSignal]);
    return !settleRequested;
  };
  let drewFrame = false;
  const draw = (lines: string[]) => {
    const prefix = drewFrame ? `\x1b[${ROWS}F` : "";
    drewFrame = true;
    write(`${prefix}${lines.map((line) => `\x1b[K${line}`).join("\n")}\n`);
  };
  // Ctrl-C during the short sequence would otherwise kill the process with the
  // cursor still hidden: default signal death skips the finally block. The
  // banner runs before any other component installs signal handlers, so a
  // scoped restore-and-exit handler is safe here and removed right after.
  const onSignal = (signal: "SIGINT" | "SIGTERM") => {
    restoreTerminalState(`banner ${signal}`);
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  const onSigint = () => onSignal("SIGINT");
  const onSigterm = () => onSignal("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  write("\x1b[?25l");
  try {
    // Wipe: dim glyphs ahead of a bright 2-column edge, color behind it.
    const wipeSteps = 5;
    for (let step = 0; step <= wipeSteps; step++) {
      const edge = Math.round((BANNER_WIDTH * step) / wipeSteps);
      const tintAt =
        (colored: (text: string) => string): CellTint =>
        (col) =>
          col < edge ? colored : col < edge + 2 ? theme.accentBright : theme.muted;
      draw(composeFrame({ wordmarkTint: tintAt(identityTint) }));
      if (!(await pause(20))) {
        return "settled";
      }
    }
    // Shimmer: a wider bright band sweeps the wordmark once.
    for (let x = 0; x < BANNER_WIDTH + 6; x += 9) {
      const band: CellTint = (col) => (col >= x && col < x + 9 ? theme.accentBright : identityTint);
      draw(composeFrame({ wordmarkTint: band }));
      if (!(await pause(20))) {
        return "settled";
      }
    }
    draw(composeFrame({}));
    return "completed";
  } finally {
    try {
      // Parallel work owns startup latency; leave a complete banner instead of
      // an interrupted frame before its logs or errors take over the terminal.
      if (settleRequested && drewFrame) {
        draw(composeFrame({}));
      }
    } finally {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      write("\x1b[?25h");
    }
  }
}

/**
 * Prints the Urbicana banner: animated on rich interactive terminals, static
 * otherwise, plain title on terminals too narrow for the art.
 */
export async function printClawBanner(
  runtime: RuntimeEnv,
  options: ClawBannerOptions = {},
): Promise<ClawBannerResult> {
  const columns = options.columns ?? process.stdout.columns ?? 80;
  if (columns < BANNER_WIDTH) {
    runtime.log(`${plainTitleLine()}\n`);
    return "static";
  }
  const env = options.env ?? process.env;
  const animate =
    (options.isTty ?? process.stdout.isTTY ?? false) &&
    (options.rich ?? isRich()) &&
    !env.CI &&
    !env.VITEST;
  if (!animate) {
    runtime.log(`${composeFrame({}).join("\n")}\n`);
    return "static";
  }
  const result = await animateBanner({
    settleWhen: options.settleWhen,
    sleep: options.sleep ?? defaultSleep,
    write: options.write ?? ((chunk) => process.stdout.write(chunk)),
  });
  (options.write ?? ((chunk: string) => process.stdout.write(chunk)))("\n");
  return result;
}
