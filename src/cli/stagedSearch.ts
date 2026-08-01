import chalk from "chalk";
import type { StagedSearchResult } from "../domain/usecases/SearchRepos.js";

// The pipeline itself lives in the domain; this file is its CLI presentation
// layer. Re-exported here so existing CLI call sites keep one import.
export {
  runStagedSearch,
  classifyIntent,
  type StagedSearchOptions,
  type StagedSearchResult,
} from "../domain/usecases/SearchRepos.js";

export function renderStagedSearch(result: StagedSearchResult, explain = false): string {
  const HR = chalk.dim("─".repeat(62));
  const DOT = chalk.dim("  ·  ");
  const pad = "       ";

  const colorHealth = (n: number) =>
    n >= 70 ? chalk.green(String(n)) : n >= 40 ? chalk.yellow(String(n)) : chalk.red(String(n));

  const colorDecay = (d: string) => {
    if (d === "Healthy") return chalk.green(d);
    if (d === "Slowing" || d === "Fading") return chalk.yellow(d);
    return chalk.red(d);
  };

  const colorConfidence = (c: string) => {
    if (c === "High") return chalk.green(c);
    if (c === "Low") return chalk.dim(c);
    return chalk.white(c);
  };

  const s = result.stageCounts;
  const pipeline = [s.stage1Raw, s.stage2QualityFloor, s.stage3PromptFit, s.stage4Ranked]
    .map(String)
    .join(chalk.dim(" → ")) + chalk.dim(" → ") + chalk.bold(String(s.stage5Returned));

  const lines: string[] = [
    "",
    `  ${chalk.bold.cyan("Repo Search")}  ${chalk.dim(result.classification.intentMode)}${DOT}${chalk.dim(result.classification.artifactType)}${DOT}${Math.round(result.classification.confidence * 100)}% confidence`,
    `  ${chalk.dim("Pipeline")}   ${pipeline}  ${chalk.dim("(raw → quality → fit → ranked → returned)")}`,
  ];

  if (result.appliedFilters.length > 0) {
    lines.push(`  ${chalk.dim("Filters")}    ${result.appliedFilters.join(DOT)}`);
  }

  lines.push(`\n  ${HR}`);

  if (result.results.length === 0) {
    lines.push(`\n  ${chalk.dim("No repos cleared the quality and prompt-fit thresholds.")}\n`);
    return `${lines.join("\n")}\n`;
  }

  result.results.forEach((entry, index) => {
    const isTop = index === 0;
    const rankMark = isTop ? chalk.yellow("★") : chalk.dim("◦");
    const nameStyled = isTop ? chalk.bold.white(entry.repo.fullName) : chalk.white(entry.repo.fullName);

    const lastPush = entry.repo.pushedAt.toISOString().slice(0, 10);
    const isStale = Date.now() - entry.repo.pushedAt.getTime() > 6 * 30 * 24 * 60 * 60 * 1000;
    const lastPushColored = isStale ? chalk.red(lastPush) : chalk.green(lastPush);

    lines.push("");
    lines.push(
      `  ${rankMark}  ${nameStyled}   ` +
      `${chalk.dim("health")} ${colorHealth(entry.healthScore)}  ${DOT.trim()}  ` +
      `${colorDecay(entry.decay)}  ${DOT.trim()}  ` +
      `${colorConfidence(entry.confidence)} confidence`
    );

    if (entry.repo.description) {
      lines.push(`${pad}${chalk.dim(entry.repo.description)}`);
    }

    lines.push("");
    lines.push(`${pad}${chalk.dim("Why")}  ${entry.whyThisRepo}`);
    lines.push(
      `${pad}${chalk.dim("Tier")}  ${entry.ownerTier}${DOT}` +
      `${chalk.dim("Type")}  ${entry.artifactType}${DOT}` +
      `${chalk.dim("Score")}  ${chalk.bold((entry.finalScore * 100).toFixed(1))}`
    );

    lines.push("");
    lines.push(
      `${pad}${chalk.yellow("★")} ${chalk.yellow(entry.repo.stars.toLocaleString())} stars${DOT}` +
      `Freshness ${Math.round(entry.freshness * 100)}%${DOT}` +
      `Last updated ${lastPushColored}`
    );

    if (entry.note) {
      lines.push(`${pad}${chalk.yellow("⚠")}  ${chalk.yellow(entry.note)}`);
    }
    if (entry.alternativesNote) {
      lines.push(`${pad}${chalk.dim(entry.alternativesNote)}`);
    }

    if (explain) {
      lines.push("");
      lines.push(
        `${pad}${chalk.dim("Prompt fit")}  ${Math.round(entry.promptFit * 100)}%  ` +
        chalk.dim(`name ${entry.breakdown.promptFit.nameMatches}  desc ${entry.breakdown.promptFit.descriptionMatches}  readme ${entry.breakdown.promptFit.readmeMatches}  topics ${entry.breakdown.promptFit.topicMatches}`)
      );
      lines.push(
        `${pad}${chalk.dim("Health")}      ` +
        chalk.dim(
          `readme ${Math.round(entry.breakdown.health.readmeQuality * 25)}/25  ` +
          `velocity ${Math.round(entry.breakdown.health.starsVelocity * 25)}/25  ` +
          `deps ${Math.round(entry.breakdown.health.dependencyFreshness * 20)}/20  ` +
          `maintenance ${Math.round(entry.breakdown.health.maintenanceQuality * 15)}/15  ` +
          `owner ${Math.round(entry.breakdown.health.ownerQuality * 15)}/15`
        )
      );
    }

    lines.push(`${pad}${chalk.blue.underline(`https://github.com/${entry.repo.fullName}`)}`);
    lines.push(`\n  ${HR}`);
  });

  return `${lines.join("\n")}\n`;
}
