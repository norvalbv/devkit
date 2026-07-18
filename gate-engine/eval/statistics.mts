/** Dependency-free Wilson score interval shared by benchmark runners and evidence adapters. */
export function wilsonScoreInterval(
  successes: number,
  total: number,
  z = 1.959963984540054,
): { lower: number; upper: number } {
  if (total <= 0) return { lower: 0, upper: 1 };
  const proportion = successes / total;
  const zSquared = z * z;
  const denominator = 1 + zSquared / total;
  const centre = (proportion + zSquared / (2 * total)) / denominator;
  const spread =
    (z * Math.sqrt((proportion * (1 - proportion) + zSquared / (4 * total)) / total)) / denominator;
  return {
    lower: Math.max(0, centre - spread),
    upper: Math.min(1, centre + spread),
  };
}
