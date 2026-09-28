/**
 * Action entrypoint.
 *
 * Deliberately thin: it exists only to invoke `run()` and translate the run's
 * status into a process exit code. All logic lives in `run.ts` and the
 * subsystem modules it orchestrates.
 *
 * Exit code semantics: the exit status represents REVIEWER OPERATIONAL HEALTH,
 * never finding severity. A run that found a `critical` bug and a run that found
 * nothing both exit 0.
 */

import { run } from "./run.js";

void run()
  .then((outputs) => {
    process.exitCode = outputs.status === "failed" ? 1 : 0;
  })
  .catch((error: unknown) => {
    // Deliberately terse. An unexpected exception must not dump a request body,
    // a prompt, or a stack containing source into the log.
    const message = error instanceof Error ? error.message : "unknown error";
    const single = message.replace(/[\r\n]+/g, " ").slice(0, 400);
    process.stdout.write(`::error::INTERNAL_ERROR ${single}\n`);
    process.exitCode = 1;
  });
