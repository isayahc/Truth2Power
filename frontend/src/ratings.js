export const ratings = [
  { stars: 5, color: "#087652", label: "Fully compliant" },
  { stars: 4, color: "#f3bc29", label: "1–3 errors" },
  { stars: 3, color: "#df782c", label: "4–6 errors" },
  { stars: 2, color: "#d03e3a", label: "7–9 errors" },
  { stars: 1, color: "#802c50", label: "Failing grade" },
  { stars: 0, color: "#232c37", label: "No application posted" },
];

export const ratingByStars = new Map(ratings.map((rating) => [rating.stars, rating]));
