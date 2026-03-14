import type { PrismaClient, Prisma } from "@prisma/client";
import type { Metrics } from "../../domain/entities/Metrics.js";
import type { TrendingRepo } from "../../domain/entities/TrendingRepo.js";
import type { MetricsRepoPort } from "../../ports/MetricsRepoPort.js";

function toLanguages(value: Prisma.JsonValue | null): Record<string, number> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record: Record<string, number> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      const num = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isNaN(num)) {
        record[key] = num;
      }
    }
    return record;
  }
  return {};
}

function getPrimaryLanguage(languages: Record<string, number>): string | null {
  let best: { name: string; bytes: number } | null = null;
  for (const [name, bytes] of Object.entries(languages)) {
    if (!best || bytes > best.bytes) {
      best = { name, bytes };
    }
  }
  return best ? best.name : null;
}

function parseStarGrowth(value: string): number {
  const match = value.match(/[+-]?\d+/);
  if (!match) return 0;
  const num = Number(match[0]);
  return Number.isNaN(num) ? 0 : num;
}

export class PrismaAdapter implements MetricsRepoPort {
  constructor(private readonly prisma: PrismaClient) {}

  async saveMetrics(data: Metrics): Promise<void> {
    await this.prisma.metrics.upsert({
      where: {
        repoOwner_repoName: {
          repoOwner: data.repoOwner,
          repoName: data.repoName,
        },
      },
      create: {
        repoOwner: data.repoOwner,
        repoName: data.repoName,
        stars: data.stars,
        starGrowth24h: data.starGrowth24h,
        languages: data.languages as Prisma.JsonObject,
        openIssues: data.openIssues,
        contributors: data.contributors,
        lastCommit: data.lastCommit,
        analyzedAt: data.analyzedAt,
      },
      update: {
        stars: data.stars,
        starGrowth24h: data.starGrowth24h,
        languages: data.languages as Prisma.JsonObject,
        openIssues: data.openIssues,
        contributors: data.contributors,
        lastCommit: data.lastCommit,
        analyzedAt: data.analyzedAt,
      },
    });
  }

  async getMetrics(owner: string, repo: string): Promise<Metrics | null> {
    const row = await this.prisma.metrics.findUnique({
      where: {
        repoOwner_repoName: {
          repoOwner: owner,
          repoName: repo,
        },
      },
    });

    if (!row) return null;

    return {
      repoOwner: row.repoOwner,
      repoName: row.repoName,
      stars: row.stars,
      starGrowth24h: row.starGrowth24h,
      languages: toLanguages(row.languages),
      openIssues: row.openIssues,
      contributors: row.contributors,
      lastCommit: row.lastCommit,
      analyzedAt: row.analyzedAt,
    };
  }

  async getTrending(language?: string): Promise<TrendingRepo[]> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows = await this.prisma.metrics.findMany({
      where: {
        analyzedAt: {
          gte: since,
        },
      },
    });

    const mapped: TrendingRepo[] = rows.map((row) => {
      const languages = toLanguages(row.languages);
      return {
        owner: row.repoOwner,
        name: row.repoName,
        stars: row.stars,
        starGrowth24h: row.starGrowth24h,
        primaryLanguage: getPrimaryLanguage(languages),
        description: null,
      };
    });

    const filtered = language
      ? mapped.filter((repo) => repo.primaryLanguage === language)
      : mapped;

    return filtered.sort(
      (a, b) => parseStarGrowth(b.starGrowth24h) - parseStarGrowth(a.starGrowth24h)
    );
  }
}
