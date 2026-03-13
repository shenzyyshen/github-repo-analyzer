/**
 * Lightweight repo summary for the trending list (owner, name, stars, growth, language, description).
 */
export interface TrendingRepo {
  owner: string;
  name: string;
  stars: number;
  starGrowth24h: string;
  primaryLanguage: string | null;
  description: string | null;
}
