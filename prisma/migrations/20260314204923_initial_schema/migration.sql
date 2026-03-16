-- CreateTable
CREATE TABLE "Repo" (
    "id" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "description" TEXT,
    "stars" INTEGER NOT NULL,
    "forks" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Repo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Metrics" (
    "id" TEXT NOT NULL,
    "repoOwner" TEXT NOT NULL,
    "repoName" TEXT NOT NULL,
    "stars" INTEGER NOT NULL,
    "starGrowth24h" TEXT NOT NULL,
    "languages" JSONB NOT NULL,
    "openIssues" INTEGER NOT NULL,
    "contributors" INTEGER NOT NULL,
    "lastCommit" TIMESTAMP(3) NOT NULL,
    "analyzedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Metrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Repo_fullName_key" ON "Repo"("fullName");

-- CreateIndex
CREATE UNIQUE INDEX "Repo_owner_name_key" ON "Repo"("owner", "name");

-- CreateIndex
CREATE INDEX "Metrics_analyzedAt_idx" ON "Metrics"("analyzedAt");

-- CreateIndex
CREATE INDEX "Metrics_repoOwner_repoName_idx" ON "Metrics"("repoOwner", "repoName");

-- CreateIndex
CREATE UNIQUE INDEX "Metrics_repoOwner_repoName_key" ON "Metrics"("repoOwner", "repoName");
