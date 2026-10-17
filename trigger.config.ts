import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  // Your Trigger.dev project ref — find it at cloud.trigger.dev → your project → Project settings.
  // It starts with "proj_". This is a public identifier, not a secret.
  project: "proj_bjyzaworpndcqaqciwmw",
  runtime: "node",
  logLevel: "log",
  // Max seconds a single task run may take before it is stopped.
  maxDuration: 3600,
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
      randomize: true,
    },
  },
  dirs: ["./src/trigger"],
});
