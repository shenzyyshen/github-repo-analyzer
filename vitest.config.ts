import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only run the TypeScript sources. Without this, a prior `npm run build`
    // leaves compiled copies in dist/ that get collected as a second, broken
    // copy of every suite.
    include: ["src/**/*.test.ts"],
  },
});
