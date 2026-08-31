/**
 * Classification vocabulary for the staged search pipeline — shared by the
 * quality-gate and scoring stages. Corresponds to action-plan-v2's
 * IntentProfile contract (Stage 0 output, consumed by every later stage).
 */
export type IntentMode = "best_match" | "best_shortlist" | "watch";
export type DomainSpeed = "fast" | "medium" | "slow";
export type ArtifactType =
  | "library"
  | "framework"
  | "cli"
  | "tips-content"
  | "dataset"
  | "boilerplate"
  | "tool";
export type FreshnessOverride = "strict" | "relaxed" | "none";
export type OwnerPreference = "company-backed" | "community" | "any";
export type Specificity = "narrow" | "broad";
export type OwnerTier = "Elite" | "Strong" | "Promising" | "Weak";
export type DecayLabel = "Healthy" | "Slowing" | "Fading" | "Abandoned";
export type DependencyHealth = "Clean" | "Minor risk" | "Supply chain risk";
export type ConfidenceLabel = "High" | "Medium" | "Low";

export type IntentClassification = {
  artifactType: ArtifactType;
  domainSpeed: DomainSpeed;
  specificity: Specificity;
  intentMode: IntentMode;
  freshnessOverride: FreshnessOverride;
  ownerPreference: OwnerPreference;
  confidence: number;
};
