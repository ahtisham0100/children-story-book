// Client-side mirror of the server's assessPasswordStrength
// (apps/api/src/auth/password.ts). Drives the live strength meter on
// /set-password. The SERVER is the real gate — this is UX only — so if the rule
// changes, update both. Kept dependency-free and identical in logic.

export const MIN_PASSWORD_LENGTH = 8;

export interface PasswordStrength {
  score: 0 | 1 | 2 | 3 | 4;
  label: "Too weak" | "Weak" | "Fair" | "Good" | "Strong";
  acceptable: boolean;
}

export function assessPasswordStrength(password: string): PasswordStrength {
  let variety = 0;
  if (/[a-z]/.test(password)) variety += 1;
  if (/[A-Z]/.test(password)) variety += 1;
  if (/[0-9]/.test(password)) variety += 1;
  if (/[^A-Za-z0-9]/.test(password)) variety += 1;

  let score = 0;
  if (password.length >= MIN_PASSWORD_LENGTH) {
    score = 1;
    if (variety >= 2) score = 2;
    if (variety >= 3 && password.length >= 10) score = 3;
    if (variety >= 4 && password.length >= 12) score = 4;
  }

  const labels: PasswordStrength["label"][] = ["Too weak", "Weak", "Fair", "Good", "Strong"];
  return {
    score: score as PasswordStrength["score"],
    label: labels[score],
    acceptable: password.length >= MIN_PASSWORD_LENGTH && variety >= 2,
  };
}
