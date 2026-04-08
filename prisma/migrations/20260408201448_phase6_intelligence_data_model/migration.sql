-- Phase 6: Intelligence data model
-- Adds 8 new tables to support velocity/decay tracking, owner intelligence,
-- dependency mapping, watch/notification workflows, search history, and trend snapshots.

-- ---------------------------------------------------------------------------
-- RepoSnapshot
-- Append-only time-series of raw GitHub metadata (stars, forks, push date).
-- Ingested on a schedule (e.g. every 24h per watched repo).
-- Prune rows older than 90 days.
-- ---------------------------------------------------------------------------
CREATE TABLE "RepoSnapshot" (
    "id"         TEXT NOT NULL,
    "fullName"   TEXT NOT NULL,
    "stars"      INTEGER NOT NULL,
    "forks"      INTEGER NOT NULL,
    "openIssues" INTEGER NOT NULL,
    "pushedAt"   TIMESTAMP(3) NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "releaseTag" TEXT,
    "snappedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RepoSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RepoSnapshot_fullName_snappedAt_idx" ON "RepoSnapshot"("fullName", "snappedAt");
CREATE INDEX "RepoSnapshot_snappedAt_idx"           ON "RepoSnapshot"("snappedAt");

-- ---------------------------------------------------------------------------
-- RepoHealthScore
-- Scored health snapshot written after a full enrichment run.
-- Kept 180 days to power stars-velocity and decay trend detection.
-- ---------------------------------------------------------------------------
CREATE TABLE "RepoHealthScore" (
    "id"                  TEXT NOT NULL,
    "fullName"            TEXT NOT NULL,
    "score"               INTEGER NOT NULL,
    "decay"               TEXT NOT NULL,
    "readmeQuality"       DOUBLE PRECISION NOT NULL,
    "starsVelocity"       DOUBLE PRECISION NOT NULL,
    "dependencyFreshness" DOUBLE PRECISION NOT NULL,
    "maintenanceQuality"  DOUBLE PRECISION NOT NULL,
    "ownerQuality"        DOUBLE PRECISION NOT NULL,
    "scoredAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RepoHealthScore_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RepoHealthScore_fullName_scoredAt_idx" ON "RepoHealthScore"("fullName", "scoredAt");
CREATE INDEX "RepoHealthScore_scoredAt_idx"           ON "RepoHealthScore"("scoredAt");

-- ---------------------------------------------------------------------------
-- OwnerProfile
-- Owner metadata enriched on first sight and refreshed weekly.
-- ---------------------------------------------------------------------------
CREATE TABLE "OwnerProfile" (
    "id"          TEXT NOT NULL,
    "login"       TEXT NOT NULL,
    "kind"        TEXT NOT NULL,
    "tier"        TEXT NOT NULL,
    "followers"   INTEGER NOT NULL DEFAULT 0,
    "publicRepos" INTEGER NOT NULL DEFAULT 0,
    "company"     TEXT,
    "bio"         TEXT,
    "knownElite"  BOOLEAN NOT NULL DEFAULT false,
    "refreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OwnerProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OwnerProfile_login_key" ON "OwnerProfile"("login");
CREATE INDEX        "OwnerProfile_tier_idx"  ON "OwnerProfile"("tier");
CREATE INDEX        "OwnerProfile_refreshedAt_idx" ON "OwnerProfile"("refreshedAt");

-- ---------------------------------------------------------------------------
-- DependencyMap
-- Edge from a repo to an upstream package or repo.
-- healthSignal: Clean | Minor risk | Supply chain risk
-- ---------------------------------------------------------------------------
CREATE TABLE "DependencyMap" (
    "id"           TEXT NOT NULL,
    "fullName"     TEXT NOT NULL,
    "depName"      TEXT NOT NULL,
    "depKind"      TEXT NOT NULL,
    "healthSignal" TEXT NOT NULL,
    "detectedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DependencyMap_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DependencyMap_fullName_depName_key" ON "DependencyMap"("fullName", "depName");
CREATE INDEX        "DependencyMap_fullName_idx"          ON "DependencyMap"("fullName");
CREATE INDEX        "DependencyMap_healthSignal_idx"      ON "DependencyMap"("healthSignal");

-- ---------------------------------------------------------------------------
-- WatchTarget
-- A repo, owner, or topic the user has asked to monitor.
-- kind: "repo" | "owner" | "topic"
-- ---------------------------------------------------------------------------
CREATE TABLE "WatchTarget" (
    "id"      TEXT NOT NULL,
    "kind"    TEXT NOT NULL,
    "ref"     TEXT NOT NULL,
    "label"   TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WatchTarget_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WatchTarget_kind_ref_key" ON "WatchTarget"("kind", "ref");
CREATE INDEX        "WatchTarget_kind_idx"      ON "WatchTarget"("kind");

-- ---------------------------------------------------------------------------
-- WatchSubscription
-- Links a subscriber (local user ID or session token) to a WatchTarget.
-- ---------------------------------------------------------------------------
CREATE TABLE "WatchSubscription" (
    "id"           TEXT NOT NULL,
    "subscriberId" TEXT NOT NULL,
    "watchId"      TEXT NOT NULL,
    "active"       BOOLEAN NOT NULL DEFAULT true,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WatchSubscription_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WatchSubscription_subscriberId_watchId_key" ON "WatchSubscription"("subscriberId", "watchId");
CREATE INDEX        "WatchSubscription_subscriberId_idx"          ON "WatchSubscription"("subscriberId");
CREATE INDEX        "WatchSubscription_watchId_idx"               ON "WatchSubscription"("watchId");

ALTER TABLE "WatchSubscription"
    ADD CONSTRAINT "WatchSubscription_watchId_fkey"
    FOREIGN KEY ("watchId") REFERENCES "WatchTarget"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- NotificationEvent
-- Triggered alert for a watch target.
-- reason: "new_repo" | "decay_change" | "score_drop" | "rising"
-- Pruned 30 days after seen = true.
-- ---------------------------------------------------------------------------
CREATE TABLE "NotificationEvent" (
    "id"       TEXT NOT NULL,
    "watchId"  TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "reason"   TEXT NOT NULL,
    "detail"   TEXT,
    "seen"     BOOLEAN NOT NULL DEFAULT false,
    "firedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "NotificationEvent_watchId_firedAt_idx" ON "NotificationEvent"("watchId", "firedAt");
CREATE INDEX "NotificationEvent_seen_firedAt_idx"    ON "NotificationEvent"("seen", "firedAt");

ALTER TABLE "NotificationEvent"
    ADD CONSTRAINT "NotificationEvent_watchId_fkey"
    FOREIGN KEY ("watchId") REFERENCES "WatchTarget"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- SearchHistory
-- Every CLI search stored for rerun and classifier tuning.
-- Retain last 500 rows per query; older rows can be pruned.
-- ---------------------------------------------------------------------------
CREATE TABLE "SearchHistory" (
    "id"              TEXT NOT NULL,
    "query"           TEXT NOT NULL,
    "mode"            TEXT NOT NULL,
    "domainSpeed"     TEXT NOT NULL,
    "artifactType"    TEXT NOT NULL,
    "topResult"       TEXT,
    "confidence"      TEXT,
    "stageCountsJson" JSONB NOT NULL,
    "filtersJson"     JSONB NOT NULL,
    "searchedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SearchHistory_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SearchHistory_searchedAt_idx" ON "SearchHistory"("searchedAt");
CREATE INDEX "SearchHistory_query_idx"       ON "SearchHistory"("query");

-- ---------------------------------------------------------------------------
-- TrendSnapshot
-- Stage-2-cleared candidate pool captured at a point in time.
-- Two snapshots of the same topic can be diffed to detect rising/fading repos.
-- ---------------------------------------------------------------------------
CREATE TABLE "TrendSnapshot" (
    "id"        TEXT NOT NULL,
    "topic"     TEXT NOT NULL,
    "reposJson" JSONB NOT NULL,
    "poolSize"  INTEGER NOT NULL,
    "snappedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrendSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TrendSnapshot_topic_snappedAt_idx" ON "TrendSnapshot"("topic", "snappedAt");
CREATE INDEX "TrendSnapshot_snappedAt_idx"        ON "TrendSnapshot"("snappedAt");
