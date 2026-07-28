import chalk from "chalk";
import type { AnalyzeRepo } from "../domain/usecases/AnalyzeRepo.js";
import type { RepoApiPort } from "../ports/RepoApiPort.js";
import type { RepoIntelligencePort } from "../ports/RepoIntelligencePort.js";
import {
  inferFilters,
  type ParsedIntent,
  type SearchInput,
} from "../domain/usecases/ParseIntent.js";
import { DiscoverRepos } from "../domain/usecases/DiscoverRepos.js";
import { applyQualityGates } from "../domain/usecases/ApplyQualityGates.js";
import { ScoreAndRank, confidenceLabel, type RankedRepo } from "../domain/usecases/ScoreAndRank.js";
import { clamp } from "../domain/shared/pipelineUtils.js";
import type {
  ArtifactType,
  DomainSpeed,
  FreshnessOverride,
  IntentClassification,
  IntentMode,
  OwnerPreference,
  Specificity,
} from "../domain/entities/IntentClassification.js";
import { DOMAIN_SPEED_TERMS } from "../config/thresholds.js";

export type StagedSearchOptions = {
  requestedMode?: IntentMode;
  top: number;
  random?: boolean;
  explain?: boolean;
};

export type StagedSearchResult = {
  query: string;
  filters: SearchInput;
  appliedFilters: string[];
  intent: ParsedIntent;
  classification: IntentClassification;
  stageCounts: {
    stage1Raw: number;
    stage2QualityFloor: number;
    stage3PromptFit: number;
    stage4Ranked: number;
    stage5Returned: number;
  };
  results: RankedRepo[];
};

function inferArtifactType(query: string, intent: ParsedIntent): ArtifactType {
  const text = [query, intent.normalizedQuery, ...intent.displayTerms, ...intent.purposeTerms].join(" ").toLowerCase();
  if (/\b(cli|terminal|command)\b/.test(text)) return "cli";
  if (/\b(framework|platform|orchestrator)\b/.test(text)) return "framework";
  if (/\b(dataset|benchmark)\b/.test(text)) return "dataset";
  if (/\b(boilerplate|starter|template)\b/.test(text)) return "boilerplate";
  if (/\b(tips|awesome|curated|guide|tutorial)\b/.test(text)) return "tips-content";
  if (/\b(library|sdk|package|module)\b/.test(text)) return "library";
  return "tool";
}

function classifyIntent(
  originalQuery: string,
  intent: ParsedIntent,
  requestedMode: IntentMode | undefined
): IntentClassification {
  const text = originalQuery.toLowerCase();
  const domainSpeed: DomainSpeed = DOMAIN_SPEED_TERMS.fast.test(text)
    ? "fast"
    : DOMAIN_SPEED_TERMS.slow.test(text)
      ? "slow"
      : "medium";
  const specificity: Specificity =
    intent.purposeTerms.length >= 4 || Boolean(intent.language) || intent.displayTerms.length >= 2
      ? "narrow"
      : "broad";
  const intentMode: IntentMode = requestedMode
    ?? (/\b(compare|options|shortlist|few choices|tradeoff)\b/.test(text) ? "best_shortlist" : "best_match");
  const freshnessOverride: FreshnessOverride = /\b(latest|new|current|today|2025|2026|recent)\b/.test(text)
    ? "strict"
    : /\b(stable|production|battle-tested|mature)\b/.test(text)
      ? "relaxed"
      : "none";
  const ownerPreference: OwnerPreference = /\b(company|official|vendor-backed)\b/.test(text)
    ? "company-backed"
    : /\b(community|independent)\b/.test(text)
      ? "community"
      : "any";

  return {
    artifactType: inferArtifactType(originalQuery, intent),
    domainSpeed,
    specificity,
    intentMode,
    freshnessOverride,
    ownerPreference,
    confidence: clamp(intent.confidence, 0, 1),
  };
}

export async function runStagedSearch(
  repoApiPort: RepoApiPort,
  analyzeRepo: AnalyzeRepo,
  repoIntelligencePort: RepoIntelligencePort,
  originalQuery: string,
  baseSearch: SearchInput,
  options: StagedSearchOptions
): Promise<StagedSearchResult> {
  const { search, applied, intent } = inferFilters(originalQuery, baseSearch);
  const classification = classifyIntent(originalQuery, intent, options.requestedMode);

  const discoverRepos = new DiscoverRepos(repoApiPort, analyzeRepo);
  const { stage1Raw, enriched } = await discoverRepos.execute(intent, search, {
    top: options.top,
    random: options.random,
  });

  const qualityPassed = applyQualityGates(enriched, classification, intent);

  const scoreAndRank = new ScoreAndRank(repoIntelligencePort);
  const { promptFitPassedCount, ranked } = await scoreAndRank.execute(qualityPassed, classification, intent);

  const returnedCount = classification.intentMode === "best_match" ? 1 : options.top;
  const results = ranked.slice(0, returnedCount).map((result, index, arr) => {
    const gap = index === 0 && arr[1] ? result.finalScore - arr[1].finalScore : 0.1;
    const closeAlternatives = index === 0
      ? arr
          .slice(1, 4)
          .filter((candidate) => Math.abs(candidate.healthScore - result.healthScore) <= 15)
          .map((candidate) => `${candidate.repo.fullName} (${candidate.artifactType}, health ${candidate.healthScore})`)
      : [];

    return {
      ...result,
      confidence: confidenceLabel({ stage3PromptFit: promptFitPassedCount }, gap),
      alternativesNote:
        index === 0 && closeAlternatives.length > 0
          ? `Alternatives worth knowing: ${closeAlternatives.join("; ")}`
          : null,
    };
  });

  return {
    query: originalQuery,
    filters: search,
    appliedFilters: applied,
    intent,
    classification,
    stageCounts: {
      stage1Raw: stage1Raw.length,
      stage2QualityFloor: qualityPassed.length,
      stage3PromptFit: promptFitPassedCount,
      stage4Ranked: ranked.length,
      stage5Returned: results.length,
    },
    results,
  };
}

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
